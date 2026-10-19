/** Live updates for the admin panel (§7.3: "reflect live"). The admin app already ships socket.io-client. */
let io = null;
const jwt = require('jsonwebtoken');
const env = require('../config/env');
function attach(httpServer) {
  const { Server } = require('socket.io');
  io = new Server(httpServer, { cors: { origin: env.corsOrigins } });
  io.use((socket, next) => {
    try {
      const p = jwt.verify(socket.handshake.auth?.token, env.JWT_SECRET, { audience: 'admin' });
      socket.data.admin = p.sub; next();
    } catch { next(new Error('unauthorized')); }
  });
  io.on('connection', (s) => s.join('admins'));
  return io;
}
const emit = (event, payload) => { try { io?.to('admins').emit(event, payload); } catch { /* never break business flow */ } };
module.exports = { attach, emit };
