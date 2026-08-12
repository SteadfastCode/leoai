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
import Billing from './views/Billing.vue'
import ResetPassword from './views/ResetPassword.vue'
import Team from './views/Team.vue'
import AcceptInvite from './views/AcceptInvite.vue'
import Crawls from './views/Crawls.vue'
import PageExplorer from './views/PageExplorer.vue'
import AdminEntities from './views/AdminEntities.vue'
import Fleet from './views/Fleet.vue'
import AuditLog from './views/AuditLog.vue'
import Chat from './views/Chat.vue'
import MinistryRequests from './views/MinistryRequests.vue'
import Signup from './views/Signup.vue'
import Codes from './views/Codes.vue'
import Logs from './views/Logs.vue'
import ApiKeys from './views/ApiKeys.vue'
import UnansweredQuestions from './views/UnansweredQuestions.vue'
import { isSuperAdminUser } from './lib/permissions'

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
    { path: '/signup', component: Signup, meta: { public: true } },
    { path: '/reset-password', component: ResetPassword, meta: { public: true } },
    { path: '/accept-invite/:token', component: AcceptInvite, meta: { public: true } },
    { path: '/overview', component: Overview },
    { path: '/conversations', component: Conversations },
    { path: '/conversations/:id', component: ConversationDetail },
    { path: '/knowledge', component: KnowledgeBase },
    { path: '/settings', component: Settings },
    { path: '/billing', component: Billing },
    { path: '/team', component: Team },
    { path: '/crawls', component: Crawls, meta: { superadmin: true } },
    { path: '/page-explorer', component: PageExplorer, meta: { superadmin: true } },
    { path: '/entities', component: AdminEntities, meta: { superadmin: true } },
    { path: '/fleet', component: Fleet, meta: { superadmin: true } },
    { path: '/audit-log', component: AuditLog, meta: { superadmin: true } },
    { path: '/chat-preview', component: Chat, meta: { superadmin: true } },
    { path: '/ministry-requests', component: MinistryRequests, meta: { superadmin: true } },
    { path: '/codes', component: Codes, meta: { superadmin: true } },
    { path: '/logs', component: Logs, meta: { superadmin: true } },
    { path: '/api-keys', component: ApiKeys, meta: { superadmin: true } },
    { path: '/unanswered', component: UnansweredQuestions },
  ],
})

// Navigation guard — redirect to login if not authenticated, and keep
// non-superadmins out of admin routes (the backend enforces its own gates;
// this just prevents rendering pages that would only 403).
router.beforeEach((to) => {
  const token = localStorage.getItem('leo_access_token')
  const user = localStorage.getItem('leo_user')
  if (!to.meta.public && (!token || !user)) {
    return '/login'
  }
  if (to.meta.superadmin && !isSuperAdminUser(JSON.parse(user || 'null'))) {
    return '/overview'
  }
})

createApp(App).use(vuetify).use(router).mount('#app')
