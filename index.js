#!/usr/bin/env node
'use strict';

const http = require('node:http');
const path = require('node:path');
const express = require('express');
const { server: WebSocketServer } = require('websocket');
const { SyncRoom } = require('./lib/sync-room');

function createServer(options = {}) {
    const app = express();
    app.use(express.static(path.join(__dirname, 'frontend')));
    app.use(express.static(path.join(__dirname, 'videosSource')));
    const server = http.createServer(app);
    const room = new SyncRoom(options);
    const wsServer = new WebSocketServer({
        httpServer: server,
        autoAcceptConnections: false,
        maxReceivedFrameSize: 16384,
        maxReceivedMessageSize: 16384,
        keepalive: true,
        keepaliveInterval: 10000,
        dropConnectionOnKeepaliveTimeout: true,
        keepaliveGracePeriod: 10000,
    });
    wsServer.on('request', request => {
        if (!request.requestedProtocols.includes('echo-protocol')) {
            request.reject(400, 'Unsupported protocol');
            return;
        }
        const connection = request.accept('echo-protocol', request.origin);
        const client = {
            send(message) {
                if (connection.connected) connection.sendUTF(JSON.stringify(message));
            },
        };
        connection.on('message', message => {
            if (message.type !== 'utf8') return;
            let data;
            try { data = JSON.parse(message.utf8Data); } catch { return; }
            room.receive(client, data);
        });
        connection.on('close', () => room.leave(client));
        connection.on('error', () => connection.close());
    });
    const timer = setInterval(() => room.tick(), 1000);
    timer.unref();
    server.on('close', () => clearInterval(timer));
    return { server, wsServer, room };
}

if (require.main === module) {
    const { server } = createServer();
    server.listen(Number(process.env.PORT) || 8080, () => {
        console.log(`Video sync server listening on port ${server.address().port}`);
    });
}

module.exports = { createServer };
