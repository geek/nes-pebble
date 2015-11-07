var ignore = function () { };

var parse = function (message, next) {

    var obj = null;
    var error = null;

    try {
        obj = JSON.parse(message);
    }
    catch (err) {
        error = err;
    }

    return next(error, obj);
};

var stringify = function (message, next) {

    var string = null;
    var error = null;

    try {
        string = JSON.stringify(message);
    }
    catch (err) {
        error = err;
    }

    return next(error, string);
};

// Client

var Client = function (url, options) {

    options = options || {};

    // Configuration

    this._url = url;
    this._settings = options;
    this._heartbeatTimeout = false;             // Server heartbeat configuration

    // State

    this._ws = null;
    this._reconnection = null;
    this._ids = 0;                              // Id counter
    this._requests = {};                        // id -> { callback, timeout }
    this._subscriptions = {};                   // path -> [callbacks]
    this._heartbeat = null;

    // Events

    this.onError = console.error;               // General error callback (only when an error cannot be associated with a request)
    this.onConnect = ignore;                    // Called whenever a connection is established
    this.onDisconnect = ignore;                 // Called whenever a connection is lost: function(willReconnect)
    this.onUpdate = ignore;

    // Public properties

    this.id = null;                             // Assigned when hello response is received
};

Client.prototype.connect = function (options, callback) {

    if (typeof options === 'function') {
        callback = arguments[0];
        options = {};
    }

    if (options.reconnect !== false) {                  // Defaults to true
        this._reconnection = {                          // Options: reconnect, delay, maxDelay
            wait: 0,
            delay: options.delay || 1000,               // 1 second
            maxDelay: options.maxDelay || 5000,         // 5 seconds
            retries: options.retries || Infinity,       // Unlimited
            settings: {
                auth: options.auth,
                timeout: options.timeout
            }
        };
    }
    else {
        this._reconnection = null;
    }

    this._connect(options, true, callback);
};

Client.prototype._connect = function (options, initial, callback) {
    
    var self = this;
    var sentCallback = false;
    var timeoutHandler = function () {

        sentCallback = true;
        self._ws.close();
        callback(new Error('Connection timed out'));
        self._cleanup();
        if (initial) {
            return self._reconnect();
        }
    };

    var timeout = (options.timeout ? setTimeout(timeoutHandler, options.timeout) : null);

    var ws = new WebSocket(self._url);  
    self._ws = ws;

    ws.onopen = function () {

        clearTimeout(timeout);

        if (!sentCallback) {
            sentCallback = true;
            return self._hello(options.auth, function (err) {
                if (err) {
                    self.disconnect();                  // Stop reconnection when the hello message returns error
                    return callback(err);
                }

                self.onConnect();
                return callback();
            });
        }
    };

    ws.onerror = function (err) {

        clearTimeout(timeout);

        if (!sentCallback) {
            sentCallback = true;
            return callback(err);
        }

        return self.onError(err);
    };

    ws.onclose = function () {

        self._cleanup();
        self.onDisconnect(!!self._reconnection);
        self._reconnect();
    };

    ws.onmessage = function (message) {

        return self._onMessage(message);
    };
};

Client.prototype.disconnect = function () {

    this._reconnection = null;

    if (!this._ws) {
        return;
    }

    if (this._ws.readyState === WebSocket.OPEN ||
        this._ws.readyState === WebSocket.CONNECTING) {

        this._ws.close();
    }
};

Client.prototype._cleanup = function () {

    var ws = this._ws;
    if (!ws) {
        return;
    }

    this._ws = null;
    this.id = null;
    ws.onopen = null;
    ws.onclose = null;
    ws.onerror = ignore;
    ws.onmessage = null;

    clearTimeout(this._heartbeat);

    // Flush pending requests

    var error = new Error('Request failed - server disconnected');

    var ids = Object.keys(this._requests);
    for (var i = 0; i < ids.length; ++i) {
        var id = ids[i];
        var request = this._requests[id];
        var callback = request.callback;
        clearTimeout(request.timeout);
        delete this._requests[id];
        callback(error);
    }
};

Client.prototype._reconnect = function () {
    
    var self = this;
    
    // Reconnect

    if (this._reconnection) {
        if (this._reconnection.retries < 1) {
            return;
        }

        --this._reconnection.retries;
        this._reconnection.wait = this._reconnection.wait + this._reconnection.delay;

        var timeout = Math.min(this._reconnection.wait, this._reconnection.maxDelay);
        setTimeout(function () {

            if (!self._reconnection) {
                return;
            }

            self._connect(self._reconnection.settings, false, function (err) {

                if (err) {
                    self.onError(err);
                    self._cleanup();
                    return self._reconnect();
                }
            });
        }, timeout);
    }
};

Client.prototype.request = function (options, callback) {

    if (typeof options === 'string') {
        options = {
            method: 'GET',
            path: options
        };
    }

    var request = {
        type: 'request',
        method: options.method || 'GET',
        path: options.path,
        headers: options.headers,
        payload: options.payload
    };

    return this._send(request, true, callback);
};

Client.prototype.message = function (message, callback) {

    var request = {
        type: 'message',
        message: message
    };

    return this._send(request, true, callback);
};

Client.prototype._send = function (request, track, callback) {
    
    var self = this;
    callback = callback || ignore;

    if (!this._ws ||
        this._ws.readyState !== WebSocket.OPEN) {

        return callback(new Error('Failed to send message - server disconnected'));
    }

    request.id = ++this._ids;

    stringify(request, function (err, encoded) {

        if (err) {
            return callback(err);
        }

        if (track) {
            var record = {
                callback: callback,
                timeout: null
            };

            if (self._settings.timeout) {
                record.timeout = setTimeout(function () {

                    record.callback = null;
                    record.timeout = null;

                    return callback(new Error('Request timed out'));
                }, self._settings.timeout);
            }

            self._requests[request.id] = record;
        }

        try {
            self._ws.send(encoded);
        }
        catch (err) {
            if (track) {
                clearTimeout(self._requests[request.id].timeout);
                delete self._requests[request.id];
            }

            return callback(err);
        }
    });
};

Client.prototype._hello = function (auth, callback) {

    var request = {
        type: 'hello'
    };

    if (auth) {
        request.auth = auth;
    }

    var subs = this.subscriptions();
    if (subs.length) {
        request.subs = subs;
    }

    return this._send(request, true, callback);
};

Client.prototype.subscriptions = function () {

    return Object.keys(this._subscriptions);
};

Client.prototype.subscribe = function (path, handler) {

    if (!path ||
        path[0] !== '/') {

        return handler(new Error('Invalid path'));
    }

    var subs = this._subscriptions[path];
    if (subs) {
        if (subs.indexOf(handler) === -1) {
            subs.push(handler);
        }

        return;
    }

    this._subscriptions[path] = [handler];

    if (!this._ws ||
        this._ws.readyState !== WebSocket.OPEN) {

        return;
    }

    var request = {
        type: 'sub',
        path: path
    };

    return this._send(request, false, function (err) {

        return handler(err);                                // Only called if send failed to transmit
    });
};

Client.prototype.unsubscribe = function (path, handler) {

    if (!path ||
        path[0] !== '/') {

        return handler(new Error('Invalid path'));
    }

    var subs = this._subscriptions[path];
    if (!subs) {
        return;
    }

    var sync = false;
    if (!handler) {
        delete this._subscriptions[path];
        sync = true;
    }
    else {
        var pos = subs.indexOf(handler);
        if (pos === -1) {
            return;
        }

        subs.splice(pos, 1);
        if (!subs.length) {
            delete this._subscriptions[path];
            sync = true;
        }
    }

    if (!sync ||
        !this._ws ||
        this._ws.readyState !== WebSocket.OPEN) {

        return;
    }

    var request = {
        type: 'unsub',
        path: path
    };

    return this._send(request, false);      // Ignoring errors as the subscription handlers are already removed
};

Client.prototype._onMessage = function (message) {
    
    var self = this;
    this._beat();

    parse(message.data, function (err, update) {

        if (err) {
            return self.onError(err);
        }

        // Recreate error

        var error = null;
        if (update.statusCode &&
            update.statusCode >= 400 &&
            update.statusCode <= 599) {

            error = new Error(update.payload.message || update.payload.error);
            error.statusCode = update.statusCode;
            error.data = update.payload;
            error.headers = update.headers;
        }

        // Ping

        if (update.type === 'ping') {
            return self._send({ type: 'ping' }, false);         // Ignore errors
        }

        // Broadcast and update

        if (update.type === 'update') {
            return self.onUpdate(update.message);
        }

        // Publish

        if (update.type === 'pub') {
            return self._notifyHandlers(update.path, null, update.message);
        }

        // Subscriptions

        if (update.type === 'sub') {
            return self._notifyHandlers(update.path, error);
        }

        // Lookup callback (message must include an id from this point)

        var request = self._requests[update.id];
        if (!request) {
            return self.onError(new Error('Received response for unknown request'));
        }

        var callback = request.callback;
        clearTimeout(request.timeout);
        delete self._requests[update.id];

        if (!callback) {
            return;                     // Response received after timeout
        }

        // Response

        if (update.type === 'request') {
            return callback(error, update.payload, update.statusCode, update.headers);
        }

        // Custom message

        if (update.type === 'message') {
            return callback(error, update.message);
        }

        // Authentication

        if (update.type === 'hello') {
            self.id = update.socket;
            if (update.heartbeat) {
                self._heartbeatTimeout = update.heartbeat.interval + update.heartbeat.timeout;
                self._beat();           // Call again once timeout is set
            }

            return callback(error);
        }

        return self.onError(new Error('Received unknown response type: ' + update.type));
    });
};

Client.prototype._beat = function () {
    
    var self = this;
    if (!self._heartbeatTimeout) {
        return;
    }

    clearTimeout(self._heartbeat);

    self._heartbeat = setTimeout(function () {

        self._ws.close();
    }, self._heartbeatTimeout);
};

Client.prototype._notifyHandlers = function (path, err, message) {

    var handlers = this._subscriptions[path];
    if (handlers) {
        if (err) {
            delete this._subscriptions[path];                        // Error means no longer subscribed
        }

        for (var i = 0; i < handlers.length; ++i) {
            handlers[i](err, message);
        }
    }
};
