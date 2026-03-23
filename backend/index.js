require('dotenv').config();
const http = require('http');
const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');
const { Server } = require('socket.io');

const { startLeoRefreshScheduler } = require('./src/services/leoRefresh');
const chatRoutes = require('./src/routes/chat');
const scrapeRoutes = require('./src/routes/scrape');
const dashboardRoutes = require('./src/routes/dashboard');
const authRoutes = require('./src/routes/auth');
const billingRoutes = require('./src/routes/billing');
const webhookRoutes = require('./src/routes/webhooks');
const knowledgeRoutes = require('./src/routes/knowledge');
const codesRoutes     = require('./src/routes/codes');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });
const PORT = process.env.PORT || 3001;

app.use(cors());

// Stripe webhook needs raw body — register BEFORE express.json()
app.use('/webhooks/stripe', webhookRoutes);

app.use(express.json());

// Attach io to app so route handlers can emit events
app.set('io', io);

app.use('/auth', authRoutes);
app.use('/chat', chatRoutes);
app.use('/scrape', scrapeRoutes);
app.use('/api/dashboard', dashboardRoutes);
app.use('/api/dashboard/entities/:domain/kb', knowledgeRoutes);
app.use('/api/billing', billingRoutes);
app.use('/api/codes', codesRoutes);

app.get('/health', (req, res) => res.json({ status: 'ok' }));

// Serve the widget demo page (test.html + chatbot.js/css) from the backend
// so the login form and API calls share the same origin with no CORS friction.
const path = require('path');
app.use('/demo', express.static(path.join(__dirname, '../widget'), { etag: false, setHeaders: (res) => res.set('Cache-Control', 'no-cache') }));

io.on('connection', (socket) => {
  // Visitors join a room by session token (for owner → visitor replies)
  socket.on('join', (sessionToken) => {
    socket.join(sessionToken);
  });
  // Dashboard clients join a room by domain (for visitor → team notifications)
  socket.on('join_domain', (domain) => {
    socket.join(`domain:${domain}`);
  });
  // Superadmin clients join a room to receive all scrape events across entities
  socket.on('join_superadmin', () => {
    socket.join('superadmin');
  });
});

mongoose
  .connect(process.env.MONGODB_URI)
  .then(() => {
    console.log('Connected to MongoDB');
    server.listen(PORT, () => console.log(`LeoAI backend running on port ${PORT}`));
    startLeoRefreshScheduler(io);
  })
  .catch((err) => {
    console.error('MongoDB connection failed:', err.message);
    process.exit(1);
  });
