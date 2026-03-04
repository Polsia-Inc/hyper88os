/**
 * i18n - Internationalization system for Polsia ES
 * Default locale: es (Spanish)
 */

const translations = {
  es: {
    // Nav
    'nav.home': 'Inicio',
    'nav.login': 'Iniciar Sesión',
    'nav.signup': 'Crear Cuenta',
    'nav.dashboard': 'Panel',
    'nav.logout': 'Cerrar Sesión',
    'nav.settings': 'Configuración',
    'nav.agents': 'Agentes',
    'nav.tasks': 'Tareas',
    'nav.reports': 'Informes',

    // Landing
    'landing.hero.title': 'Agentes de IA que operan tu negocio',
    'landing.hero.subtitle': 'Automatiza marketing, ventas, soporte y operaciones con agentes inteligentes que trabajan 24/7.',
    'landing.hero.cta': 'Comenzar Gratis',
    'landing.hero.cta2': 'Ver Demo',
    'landing.features.title': 'Todo lo que necesitas para escalar',
    'landing.features.agents.title': 'Agentes Autónomos',
    'landing.features.agents.desc': 'Agentes de IA que ejecutan tareas complejas sin supervisión. Marketing, ventas, soporte — todo automatizado.',
    'landing.features.tasks.title': 'Gestión de Tareas',
    'landing.features.tasks.desc': 'Asigna trabajo a tus agentes y monitorea el progreso en tiempo real. Sin microgestión.',
    'landing.features.analytics.title': 'Analítica Inteligente',
    'landing.features.analytics.desc': 'Informes automáticos sobre rendimiento, métricas clave y oportunidades de mejora.',
    'landing.features.integrations.title': 'Integraciones Nativas',
    'landing.features.integrations.desc': 'Conecta con Stripe, email, redes sociales y más. Todo funciona desde el primer día.',
    'landing.pricing.title': 'Precios Simples',
    'landing.pricing.free.name': 'Gratis',
    'landing.pricing.free.price': '$0',
    'landing.pricing.free.period': '/mes',
    'landing.pricing.free.features': ['1 agente activo', 'Tareas básicas', 'Panel de control', 'Soporte por email'],
    'landing.pricing.pro.name': 'Pro',
    'landing.pricing.pro.price': '$29',
    'landing.pricing.pro.period': '/mes',
    'landing.pricing.pro.features': ['Agentes ilimitados', 'Tareas prioritarias', 'Analítica avanzada', 'Integraciones premium', 'Soporte prioritario'],
    'landing.pricing.enterprise.name': 'Empresa',
    'landing.pricing.enterprise.price': 'Contactar',
    'landing.pricing.enterprise.period': '',
    'landing.pricing.enterprise.features': ['Todo en Pro', 'API dedicada', 'SLA garantizado', 'Onboarding personalizado', 'Soporte dedicado'],
    'landing.cta.title': '¿Listo para automatizar tu negocio?',
    'landing.cta.subtitle': 'Únete a cientos de empresas que ya usan agentes de IA para crecer más rápido.',
    'landing.cta.button': 'Empezar Ahora',
    'landing.footer.rights': 'Todos los derechos reservados.',
    'landing.stats.businesses': 'Negocios activos',
    'landing.stats.tasks': 'Tareas completadas',
    'landing.stats.uptime': 'Disponibilidad',
    'landing.stats.savings': 'Ahorro promedio',

    // Auth
    'auth.login.title': 'Iniciar Sesión',
    'auth.login.subtitle': 'Accede a tu panel de control',
    'auth.login.email': 'Correo electrónico',
    'auth.login.password': 'Contraseña',
    'auth.login.button': 'Entrar',
    'auth.login.loading': 'Entrando...',
    'auth.login.no_account': '¿No tienes cuenta?',
    'auth.login.create': 'Crear cuenta',
    'auth.login.error': 'Correo o contraseña incorrectos',
    'auth.signup.title': 'Crear Cuenta',
    'auth.signup.subtitle': 'Comienza a automatizar tu negocio',
    'auth.signup.name': 'Nombre completo',
    'auth.signup.email': 'Correo electrónico',
    'auth.signup.password': 'Contraseña',
    'auth.signup.confirm': 'Confirmar contraseña',
    'auth.signup.button': 'Crear Cuenta',
    'auth.signup.loading': 'Creando cuenta...',
    'auth.signup.has_account': '¿Ya tienes cuenta?',
    'auth.signup.login': 'Iniciar sesión',
    'auth.signup.error.mismatch': 'Las contraseñas no coinciden',
    'auth.signup.error.exists': 'Ya existe una cuenta con este correo',
    'auth.signup.error.weak': 'La contraseña debe tener al menos 10 caracteres, 1 letra y 1 número',
    'auth.password.requirements': 'La contraseña debe contener:',
    'auth.password.length': 'Al menos 10 caracteres',
    'auth.password.letter': 'Al menos 1 letra',
    'auth.password.number': 'Al menos 1 número',

    // Dashboard
    'dashboard.welcome': 'Bienvenido',
    'dashboard.overview': 'Resumen',
    'dashboard.agents.title': 'Agentes',
    'dashboard.agents.active': 'Activos',
    'dashboard.agents.idle': 'Inactivos',
    'dashboard.tasks.title': 'Tareas',
    'dashboard.tasks.pending': 'Pendientes',
    'dashboard.tasks.completed': 'Completadas',
    'dashboard.tasks.in_progress': 'En progreso',
    'dashboard.recent': 'Actividad Reciente',
    'dashboard.no_activity': 'No hay actividad reciente. Tus agentes empezarán a trabajar pronto.',
    'dashboard.sidebar.overview': 'Resumen',
    'dashboard.sidebar.agents': 'Agentes',
    'dashboard.sidebar.tasks': 'Tareas',
    'dashboard.sidebar.reports': 'Informes',
    'dashboard.sidebar.settings': 'Configuración',
    'dashboard.sidebar.help': 'Ayuda',

    // General
    'general.back': 'Volver',
    'general.save': 'Guardar',
    'general.cancel': 'Cancelar',
    'general.delete': 'Eliminar',
    'general.edit': 'Editar',
    'general.loading': 'Cargando...',
    'general.error': 'Algo salió mal. Inténtalo de nuevo.',
    'general.success': 'Operación exitosa',
  },

  en: {
    'nav.home': 'Home',
    'nav.login': 'Log In',
    'nav.signup': 'Sign Up',
    'nav.dashboard': 'Dashboard',
    'nav.logout': 'Log Out',
    'nav.settings': 'Settings',
    'nav.agents': 'Agents',
    'nav.tasks': 'Tasks',
    'nav.reports': 'Reports',
    'landing.hero.title': 'AI agents that run your business',
    'landing.hero.subtitle': 'Automate marketing, sales, support and operations with intelligent agents working 24/7.',
    'landing.hero.cta': 'Start Free',
    'auth.login.title': 'Log In',
    'auth.signup.title': 'Sign Up',
    'dashboard.welcome': 'Welcome',
  }
};

function t(key, locale = 'es') {
  return translations[locale]?.[key] || translations['es']?.[key] || key;
}

function getTranslations(locale = 'es') {
  return { ...translations['es'], ...(translations[locale] || {}) };
}

module.exports = { t, getTranslations, translations };
