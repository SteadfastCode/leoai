import { ref } from 'vue'
import { io } from 'socket.io-client'

const BACKEND_URL = 'http://localhost:3001'

// Module-level singleton — one connection for the whole dashboard session
export const socket = io(BACKEND_URL, { autoConnect: false })
export const socketConnected = ref(false)

socket.on('connect',    () => { socketConnected.value = true })
socket.on('disconnect', () => { socketConnected.value = false })

export function joinDomain(domain) {
  if (domain) socket.emit('join_domain', domain)
}
