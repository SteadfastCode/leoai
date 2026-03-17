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

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

// Attach io to app so route handlers can emit events
app.set('io', io);

app.use('/auth', authRoutes);
app.use('/chat', chatRoutes);
app.use('/scrape', scrapeRoutes);
app.use('/api/dashboard', dashboardRoutes);

app.get('/health', (req, res) => res.json({ status: 'ok' }));

// Visitors join a room named after their session token
io.on('connection', (socket) => {
  socket.on('join', (sessionToken) => {
    socket.join(sessionToken);
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
