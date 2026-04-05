/**
 * Austin YOUR_PROPERTY_NAME - Site Components
 *
 * Shared components for the main AAP website.
 * These components generate the header, navigation, and footer.
 */

import { initAuth, getAuthState, signOut } from './auth.js';

// =============================================
// CONFIGURATION
// =============================================

// Image URLs - transparent PNGs from Supabase storage
const LOGO_BASE = 'YOUR_SUPABASE_URL/storage/v1/object/public/housephotos/logos';
const ALPACA_ICON_FALLBACK = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 21 30"><rect width="21" height="30" rx="4" fill="none"/><path d="M10.5 1.5C8.3 1.5 6.5 3.3 6.5 5.5v4.1L3.8 13c-1 1.3-1.5 2.8-1.5 4.4 0 4.6 3.7 8.3 8.2 8.3s8.2-3.7 8.2-8.3c0-1.6-.5-3.2-1.5-4.4l-2.7-3.4V5.5c0-2.2-1.8-4-4-4z" fill="#1f1720"/><ellipse cx="10.5" cy="18.6" rx="3.1" ry="4.7" fill="#f6f5f0"/></svg>');
const ALPACA_WORDMARK_FALLBACK = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 28"><rect width="120" height="28" fill="none"/><text x="0" y="20" font-size="16" font-family="Arial,sans-serif" fill="#1f1720">Property</text></svg>');
const IMAGES = {
  // Property head icon (transparent PNGs)
  icon: `${LOGO_BASE}/logo-black-transparent.png`,        // black on transparent - for light backgrounds
  iconInverted: `${LOGO_BASE}/logo-white-transparent.png`, // white on transparent - for dark backgrounds
  // Wordmark (transparent PNGs)
  wordmark: `${LOGO_BASE}/wordmark-black-transparent.png`,        // black on transparent - for light backgrounds
  wordmarkInverted: `${LOGO_BASE}/wordmark-white-transparent.png`, // white on transparent - for dark backgrounds
  // Legacy aliases
  logo: `${LOGO_BASE}/logo-white-transparent.png`,
  logoLight: `${LOGO_BASE}/logo-black-transparent.png`,
  heroPropertys: 'https://images.squarespace-cdn.com/content/v1/6213d804273001551ffe5b8c/4e23696e-623b-4621-8f3a-c223a521131b/P1020387.jpeg',
};

// Base path for links (root on YOUR_DOMAIN)
// Change this if deploying to a different subdirectory
const BASE_PATH = '';

// Navigation links - unified across all pages
// Logo clicks to Home, so Home is not in the nav
const NAV_LINKS = [
  { text: 'Visiting', href: `${BASE_PATH}/visiting/` },
  { text: 'Rentals', href: `${BASE_PATH}/spaces/` },
  { text: 'Events', href: `${BASE_PATH}/events/` },
  { text: 'Community', href: `${BASE_PATH}/community/` },
  { text: 'Photos', href: `${BASE_PATH}/photos/` },
  { text: 'Contact', href: `${BASE_PATH}/contact/` },
];

// Mistiq link - only shown on Mistiq pages
const MISTIQ_LINK = { text: 'Mistiq', href: `${BASE_PATH}/mistiq/` };
const AUTH_LINK = { text: 'Sign In', href: `${BASE_PATH}/login/` };

// =============================================
// HEADER COMPONENT
// =============================================

/**
 * Generate the site header HTML
 * @param {Object} options - Header options
 * @param {boolean} options.transparent - Start with transparent background (for hero pages)
 * @param {boolean} options.light - Use light (white) text/logo
 * @param {string} options.activePage - Current page identifier for nav highlighting
 * @param {boolean} options.showMistiq - Whether to show the Mistiq nav link (only true on Mistiq pages)
 * @param {string} options.version - Version string for display in header
 */
function renderHeader(options = {}) {
  const { transparent = false, light = true, activePage = '', showMistiq = false, version = '' } = options;

  const headerClass = transparent ? 'aap-header--transparent' : 'aap-header--solid';
  const colorClass = light ? 'aap-header--light' : 'aap-header--dark';

  // Build navigation links - include Mistiq only if showMistiq is true
  const links = showMistiq ? [...NAV_LINKS, MISTIQ_LINK] : NAV_LINKS;
  const linksWithAuth = [...links, AUTH_LINK];

  const navItems = linksWithAuth.map(link => {
    const isActive = link.href.includes(activePage) && activePage !== '';
    const activeClass = isActive ? 'aap-nav__link--active' : '';
    // Add ID to Sign In link so initPublicHeaderAuth can find and hide it
    const signInId = link.text === 'Sign In' ? ' id="aapSignInLink"' : '';
    return `<li><a href="${link.href}" class="aap-nav__link ${activeClass}"${signInId}>${link.text}</a></li>`;
  }).join('');

  return `
    <header class="aap-header ${headerClass} ${colorClass}" id="aap-header">
      <div class="aap-header__inner">
        <a href="${BASE_PATH}/" class="aap-header__logo">
          <img src="${light ? IMAGES.iconInverted : IMAGES.icon}" alt="YOUR_PROPERTY_NAME Austin" class="aap-header__icon" width="21" height="30" data-light-src="${IMAGES.iconInverted}" data-dark-src="${IMAGES.icon}" onerror="this.onerror=null;this.src='${ALPACA_ICON_FALLBACK}'">
          <img src="${light ? IMAGES.wordmarkInverted : IMAGES.wordmark}" alt="YOUR_PROPERTY_NAME Austin" class="aap-header__wordmark" width="22" height="22" data-light-src="${IMAGES.wordmarkInverted}" data-dark-src="${IMAGES.wordmark}" onerror="this.onerror=null;this.src='${ALPACA_WORDMARK_FALLBACK}'">
          <span title="Site version" class="aap-header__version">${version || ''}</span>
        </a>
        <nav class="aap-nav" id="aap-nav">
          <ul class="aap-nav__list">
            ${navItems}
          </ul>
        </nav>

        <div id="aapHeaderAuth" class="aap-header-auth"></div>

        <button class="aap-menu-toggle" id="aap-menu-toggle" aria-label="Toggle menu">
          <span class="aap-menu-toggle__bar"></span>
          <span class="aap-menu-toggle__bar"></span>
          <span class="aap-menu-toggle__bar"></span>
        </button>
      </div>
    </header>

    ${renderMobileNav(activePage, showMistiq)}
  `;
}

/**
 * Generate mobile navigation overlay
 * @param {string} activePage - Current page identifier for nav highlighting
 * @param {boolean} showMistiq - Whether to show the Mistiq nav link
 */
function renderMobileNav(activePage = '', showMistiq = false) {
  // Build navigation links - include Mistiq only if showMistiq is true
  const links = showMistiq ? [...NAV_LINKS, MISTIQ_LINK] : NAV_LINKS;
  const linksWithAuth = [...links, AUTH_LINK];

  const navItems = linksWithAuth.map(link => {
    const isActive = link.href.includes(activePage) && activePage !== '';
    const activeClass = isActive ? 'aap-mobile-nav__link--active' : '';
    const signInId = link.text === 'Sign In' ? ' id="aapMobileSignInLink"' : '';
    return `
      <li class="aap-mobile-nav__item">
        <a href="${link.href}" class="aap-mobile-nav__link ${activeClass}"${signInId}>${link.text}</a>
      </li>
    `;
  }).join('');

  return `
    <div class="aap-mobile-nav" id="aap-mobile-nav">
      <button class="aap-mobile-nav__close" id="aap-mobile-nav-close" aria-label="Close menu">×</button>
      <ul class="aap-mobile-nav__list">
        ${navItems}
      </ul>
    </div>
  `;
}

// =============================================
// FOOTER COMPONENT
// =============================================

/**
 * Generate the site footer HTML
 */
function renderFooter() {
  const currentYear = new Date().getFullYear();

  return `
    <footer class="aap-footer">
      <div class="aap-footer__content">
        <div class="aap-footer__logo">
          <img src="${IMAGES.iconInverted}" alt="YOUR_PROPERTY_NAME Austin" class="aap-footer__icon">
          <img src="${IMAGES.wordmarkInverted}" alt="YOUR_PROPERTY_NAME Austin" class="aap-footer__wordmark">
        </div>

        <div class="aap-footer__social">
          <a href="https://www.facebook.com/yourorg" target="_blank" rel="noopener" aria-label="Facebook">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
              <path d="M18 2h-3a5 5 0 0 0-5 5v3H7v4h3v8h4v-8h3l1-4h-4V7a1 1 0 0 1 1-1h3z"/>
            </svg>
          </a>
          <a href="https://instagram.com/yourorgatx" target="_blank" rel="noopener" aria-label="Instagram">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
              <rect x="2" y="2" width="20" height="20" rx="5" ry="5" fill="none" stroke="currentColor" stroke-width="2"/>
              <circle cx="12" cy="12" r="4" fill="none" stroke="currentColor" stroke-width="2"/>
              <circle cx="18" cy="6" r="1"/>
            </svg>
          </a>
        </div>

        <p class="aap-footer__copyright">
          © ${currentYear} Austin YOUR_PROPERTY_NAME. All rights reserved.<br>
          123 Main Stive, Your City, TX 00000
        </p>
      </div>
    </footer>
  `;
}

// =============================================
// HERO COMPONENT
// =============================================

/**
 * Generate a hero section
 * @param {Object} options - Hero options
 * @param {string} options.image - Background image URL
 * @param {string} options.title - Hero title
 * @param {string} options.subtitle - Hero subtitle
 * @param {string} options.height - 'full' (100vh), 'medium' (70vh), or 'short' (50vh)
 * @param {string} options.buttonText - Optional CTA button text
 * @param {string} options.buttonLink - Optional CTA button link
 */
function renderHero(options = {}) {
  const {
    image = IMAGES.heroPropertys,
    title = '',
    subtitle = '',
    height = 'full',
    buttonText = '',
    buttonLink = '',
  } = options;

  const heightClass = height === 'full' ? '' :
                      height === 'medium' ? 'aap-hero--medium' :
                      'aap-hero--short';

  const button = buttonText && buttonLink ?
    `<a href="${buttonLink}" class="aap-btn aap-btn--outline aap-btn--light">${buttonText}</a>` : '';

  return `
    <section class="aap-hero ${heightClass}" style="background-image: url('${image}')">
      <div class="aap-hero__content">
        ${title ? `<h1 class="aap-hero__title">${title}</h1>` : ''}
        ${subtitle ? `<p class="aap-hero__subtitle">${subtitle}</p>` : ''}
        ${button}
      </div>
    </section>
  `;
}

// =============================================
// INITIALIZATION
// =============================================

/**
 * Ensure Google Fonts are loaded
 * Injects the <link> if not already present in <head>
 */
function loadGoogleFonts() {
  const fontId = 'aap-google-fonts';
  if (document.getElementById(fontId)) return;

  // Preconnect for faster font loading
  const preconnect1 = document.createElement('link');
  preconnect1.rel = 'preconnect';
  preconnect1.href = 'https://fonts.googleapis.com';
  document.head.appendChild(preconnect1);

  const preconnect2 = document.createElement('link');
  preconnect2.rel = 'preconnect';
  preconnect2.href = 'https://fonts.gstatic.com';
  preconnect2.crossOrigin = 'anonymous';
  document.head.appendChild(preconnect2);

  // Load fonts stylesheet
  const link = document.createElement('link');
  link.id = fontId;
  link.rel = 'stylesheet';
  link.href = 'https://fonts.googleapis.com/css2?family=DM+Sans:ital,opsz,wght@0,9..40,300;0,9..40,400;0,9..40,500;0,9..40,600;0,9..40,700;1,9..40,400&display=swap';
  document.head.appendChild(link);
}

/**
 * Initialize scroll reveal animations using IntersectionObserver
 * Elements with class .aap-reveal will fade in when scrolled into view
 */
function initScrollReveal() {
  if (!('IntersectionObserver' in window)) return;

  const observer = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        entry.target.classList.add('aap-reveal--visible');
        observer.unobserve(entry.target);
      }
    });
  }, {
    threshold: 0.1,
    rootMargin: '0px 0px -40px 0px',
  });

  document.querySelectorAll('.aap-reveal').forEach(el => observer.observe(el));
}

/**
 * Initialize site components
 * Call this after the DOM is ready
 */
function initSiteComponents() {
  // Load Google Fonts dynamically
  loadGoogleFonts();

  // Header scroll behavior
  const header = document.getElementById('aap-header');
  if (header && header.classList.contains('aap-header--transparent')) {
    const swapLogos = (useDark) => {
      header.querySelectorAll('[data-light-src][data-dark-src]').forEach(img => {
        img.src = useDark ? img.dataset.darkSrc : img.dataset.lightSrc;
      });
    };
    window.addEventListener('scroll', () => {
      if (window.scrollY > 50) {
        header.classList.remove('aap-header--transparent');
        header.classList.add('aap-header--solid');
        header.classList.remove('aap-header--light');
        header.classList.add('aap-header--dark');
        swapLogos(true); // solid white bg → dark/green logos
      } else {
        header.classList.add('aap-header--transparent');
        header.classList.remove('aap-header--solid');
        header.classList.add('aap-header--light');
        header.classList.remove('aap-header--dark');
        swapLogos(false); // transparent over hero → inverted/white logos
      }
    });
  }

  // Mobile menu toggle
  const menuToggle = document.getElementById('aap-menu-toggle');
  const mobileNav = document.getElementById('aap-mobile-nav');
  const mobileNavClose = document.getElementById('aap-mobile-nav-close');

  if (menuToggle && mobileNav) {
    menuToggle.addEventListener('click', () => {
      mobileNav.classList.add('aap-mobile-nav--open');
      document.body.style.overflow = 'hidden';
    });
  }

  if (mobileNavClose && mobileNav) {
    mobileNavClose.addEventListener('click', () => {
      mobileNav.classList.remove('aap-mobile-nav--open');
      document.body.style.overflow = '';
    });
  }

  // Close mobile nav when clicking a link
  if (mobileNav) {
    mobileNav.querySelectorAll('a').forEach(link => {
      link.addEventListener('click', () => {
        mobileNav.classList.remove('aap-mobile-nav--open');
        document.body.style.overflow = '';
      });
    });
  }

  // Initialize scroll reveal animations
  initScrollReveal();

  // Enable smooth scrolling for anchor links
  document.querySelectorAll('a[href^="#"]').forEach(anchor => {
    anchor.addEventListener('click', function (e) {
      const target = document.querySelector(this.getAttribute('href'));
      if (target) {
        e.preventDefault();
        target.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    });
  });
}

// =============================================
// PUBLIC HEADER AUTH (Sign In vs profile when signed in)
// =============================================

function getInitials(name) {
  if (!name) return '?';
  const parts = String(name).trim().split(/\s+/);
  if (parts.length >= 2) return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  return (name[0] || '?').toUpperCase();
}

function escapeHtml(s) {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

/**
 * Render user menu HTML (avatar + name + dropdown) for public header.
 * Caller must attach to DOM and bind dropdown/sign-out in initPublicHeaderAuth.
 */
function renderUserMenuHTML(appUser, profileHref) {
  const name = appUser.display_name || appUser.email;
  const initials = getInitials(name);
  const avatarUrl = appUser.avatar_url;
  const avatarHtml = avatarUrl
    ? `<img src="${avatarUrl}" alt="" class="user-avatar">`
    : `<span class="user-avatar user-avatar--initials">${initials}</span>`;

  // Role-based navigation links
  const role = appUser.role || '';
  const isResident = ['admin', 'oracle', 'staff', 'resident', 'associate'].includes(role);

  let navLinks = '';
  if (isResident) {
    navLinks += `<a href="/spaces/admin/rentals.html" class="user-menu-item">Intranet</a>`;
  }

  return `
    <button class="user-menu-trigger" aria-haspopup="true" aria-expanded="false">
      ${avatarHtml}<span class="user-profile-name">${escapeHtml(name)}</span>
    </button>
    <div class="user-menu-dropdown hidden">
      <a href="${profileHref}" class="user-menu-item">Profile</a>
      ${navLinks}
      <button class="user-menu-item user-menu-signout" id="publicHeaderSignOutBtn">Sign Out</button>
    </div>`;
}

/**
 * Initialize public header auth: show profile when signed in, Sign In link when not.
 * @param {Object} options
 * @param {string} options.authContainerId - ID of element to fill with user menu when signed in
 * @param {string} options.signInLinkId - ID of Sign In link to hide when signed in
 * @param {string} [options.profileHref='/residents/profile.html'] - Profile link for dropdown
 */
export async function initPublicHeaderAuth({ authContainerId, signInLinkId, profileHref = '/residents/profile.html' }) {
  const authEl = document.getElementById(authContainerId);
  const signInEl = document.getElementById(signInLinkId);
  if (!authEl) return;

  await initAuth();
  const state = getAuthState();

  // Also find mobile nav Sign In link
  const mobileSignInEl = document.getElementById('aapMobileSignInLink');

  if (state.appUser) {
    authEl.innerHTML = renderUserMenuHTML(state.appUser, profileHref);
    authEl.classList.add('user-info');
    if (signInEl) signInEl.style.display = 'none';

    // Inject role-based links into mobile nav, replacing the Sign In link
    if (mobileSignInEl) {
      const mobileLi = mobileSignInEl.closest('li');
      const mobileList = mobileLi?.parentElement;
      if (mobileList && mobileLi) {
        const role = state.appUser.role || '';
        const isResident = ['admin', 'oracle', 'staff', 'resident', 'associate'].includes(role);
        // Build mobile nav items for authenticated user
        const mobileItems = [];
        if (isResident) {
          mobileItems.push(`<li class="aap-mobile-nav__item"><a href="/spaces/admin/rentals.html" class="aap-mobile-nav__link">Intranet</a></li>`);
        }
        mobileItems.push(`<li class="aap-mobile-nav__item"><a href="/residents/profile.html" class="aap-mobile-nav__link">Profile</a></li>`);
        mobileItems.push(`<li class="aap-mobile-nav__item"><button class="aap-mobile-nav__link aap-mobile-nav__signout" id="mobileSignOutBtn" style="background:none;border:none;color:#c0392b;cursor:pointer;font:inherit;padding:inherit;width:100%;text-align:left;">Sign Out</button></li>`);

        mobileLi.outerHTML = mobileItems.join('');

        // Bind mobile sign out
        document.getElementById('mobileSignOutBtn')?.addEventListener('click', async () => {
          await signOut();
          window.location.href = '/login/?redirect=' + encodeURIComponent(window.location.pathname);
        });
      }
    }

    const trigger = authEl.querySelector('.user-menu-trigger');
    const dropdown = authEl.querySelector('.user-menu-dropdown');
    if (trigger && dropdown) {
      trigger.addEventListener('click', (e) => {
        e.stopPropagation();
        const open = !dropdown.classList.contains('hidden');
        dropdown.classList.toggle('hidden', open);
        trigger.setAttribute('aria-expanded', !open);
      });
      document.addEventListener('click', () => {
        dropdown.classList.add('hidden');
        trigger.setAttribute('aria-expanded', 'false');
      });
    }
    authEl.querySelector('#publicHeaderSignOutBtn')?.addEventListener('click', async () => {
      await signOut();
      window.location.href = '/login/?redirect=' + encodeURIComponent(window.location.pathname);
    });
  } else {
    authEl.innerHTML = '';
    authEl.classList.remove('user-info');
    if (signInEl) signInEl.style.display = '';
  }
}

// =============================================
// EXPORTS
// =============================================

export {
  IMAGES,
  BASE_PATH,
  NAV_LINKS,
  MISTIQ_LINK,
  renderHeader,
  renderMobileNav,
  renderFooter,
  renderHero,
  initSiteComponents,
  loadGoogleFonts,
  initScrollReveal,
};

// Also make available globally for non-module scripts
if (typeof window !== 'undefined') {
  window.aapSite = {
    IMAGES,
    BASE_PATH,
    NAV_LINKS,
    MISTIQ_LINK,
    renderHeader,
    renderMobileNav,
    renderFooter,
    renderHero,
    initSiteComponents,
    loadGoogleFonts,
    initScrollReveal,
    initPublicHeaderAuth,
  };
}
