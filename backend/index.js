require('dotenv').config();
const http = require('http');
const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');
const { Server } = require('socket.io');

const chatRoutes = require('./src/routes/chat');
const scrapeRoutes = require('./src/routes/scrape');
const dashboardRoutes = require('./src/routes/dashboard');
const authRoutes = require('./src/routes/auth');
const billingRoutes = require('./src/routes/billing');
const webhookRoutes = require('./src/routes/webhooks');

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
app.use('/api/billing', billingRoutes);

app.get('/health', (req, res) => res.json({ status: 'ok' }));

io.on('connection', (socket) => {
  // Visitors join a room by session token (for owner → visitor replies)
  socket.on('join', (sessionToken) => {
    socket.join(sessionToken);
  });
  // Dashboard clients join a room by domain (for visitor → team notifications)
  socket.on('join_domain', (domain) => {
    socket.join(`domain:${domain}`);
  });
});

mongoose
  .connect(process.env.MONGODB_URI)
  .then(() => {
    console.log('Connected to MongoDB');
    server.listen(PORT, () => console.log(`LeoAI backend running on port ${PORT}`));
  })
  .catch((err) => {
    console.error('MongoDB connection failed:', err.message);
    process.exit(1);
  });
