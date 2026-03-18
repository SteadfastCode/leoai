import { ref } from 'vue'
import { io } from 'socket.io-client'

const BACKEND_URL = 'http://localhost:3001'

// Module-level singleton — one connection for the whole dashboard session
export const socket = io(BACKEND_URL, { autoConnect: false, transports: ['polling', 'websocket'] })
export const socketConnected = ref(false)

let _domain = ''

// Re-join the domain room on every connection, including reconnects after
// a backend restart (server loses all room memberships on restart)
socket.on('connect', () => {
  socketConnected.value = true
  if (_domain) socket.emit('join_domain', _domain)
})

socket.on('disconnect', () => { socketConnected.value = false })

export function joinDomain(domain) {
  _domain = domain
  // If already connected, join immediately; otherwise the connect handler above
  // will pick it up once the connection is established
  if (domain && socket.connected) socket.emit('join_domain', domain)
}
