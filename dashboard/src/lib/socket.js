import { ref } from 'vue'
import { io } from 'socket.io-client'

const BACKEND_URL = 'http://localhost:3001'

// Module-level singleton — one connection for the whole dashboard session
export const socket = io(BACKEND_URL, { autoConnect: false, transports: ['polling', 'websocket'] })
export const socketConnected = ref(false)

// Reactive counter — increments on every new_message event.
// Components watch this instead of registering their own socket listeners,
// avoiding lifecycle timing issues with socket.on registration.
export const newMessageTick = ref(0)

let _domain = ''

socket.on('connect', () => {
  socketConnected.value = true
  if (_domain) socket.emit('join_domain', _domain)
})

socket.on('disconnect', () => { socketConnected.value = false })

socket.on('new_message', () => { newMessageTick.value++ })

export function joinDomain(domain) {
  _domain = domain
  if (domain && socket.connected) socket.emit('join_domain', domain)
}
