import { createApp } from 'vue'
import { createVuetify } from 'vuetify'
import { createRouter, createWebHashHistory } from 'vue-router'
import * as components from 'vuetify/components'
import * as directives from 'vuetify/directives'
import '@mdi/font/css/materialdesignicons.css'
import 'vuetify/styles'
import App from './App.vue'
import Login from './views/Login.vue'
import Overview from './views/Overview.vue'
import Conversations from './views/Conversations.vue'
import ConversationDetail from './views/ConversationDetail.vue'
import KnowledgeBase from './views/KnowledgeBase.vue'
import Settings from './views/Settings.vue'

const savedTheme = localStorage.getItem('leo_dashboard_theme') || 'light'

const vuetify = createVuetify({
  components,
  directives,
  theme: {
    defaultTheme: savedTheme,
    themes: {
      light: {
        colors: {
          primary: '#2563eb',
          secondary: '#64748b',
          background: '#f8fafc',
          surface: '#ffffff',
        },
      },
      dark: {
        colors: {
          primary: '#3b82f6',
          secondary: '#94a3b8',
          background: '#0f172a',
          surface: '#1e293b',
        },
      },
    },
  },
})

const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    { path: '/', redirect: '/overview' },
    { path: '/login', component: Login, meta: { public: true } },
    { path: '/overview', component: Overview },
    { path: '/conversations', component: Conversations },
    { path: '/conversations/:id', component: ConversationDetail },
    { path: '/knowledge', component: KnowledgeBase },
    { path: '/settings', component: Settings },
  ],
})

// Navigation guard — redirect to login if not authenticated
router.beforeEach((to) => {
  const token = localStorage.getItem('leo_access_token')
  const user = localStorage.getItem('leo_user')
  if (!to.meta.public && (!token || !user)) {
    return '/login'
  }
})

createApp(App).use(vuetify).use(router).mount('#app')
