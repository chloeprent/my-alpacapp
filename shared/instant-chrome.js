/**
 * Instant Chrome - Pre-render header shell for returning users with cached auth.
 *
 * NOTE: Overlay hiding and content visibility are now handled by inline
 * <script>+<style> in each page's <head> (runs before first paint).
 * This script's main job is pre-rendering the header shell with logo images.
 * The overlay.style.display='none' and content.classList.remove('hidden')
 * calls below are redundant but kept for backwards compatibility.
 *
 * IMPORTANT: This must be a regular (non-module) script so it executes
 * synchronously before module scripts. Place it at the end of <body>,
 * after #appContent, before module <script> tags.
 */
(function () {
  try {
    var cached = localStorage.getItem('your-project-cached-auth');
    if (!cached) return;
    var data = JSON.parse(cached);
    if (!data || !data.appUser) return;

    // Show app content immediately, hide loading spinner
    var overlay = document.getElementById('loadingOverlay');
    var content = document.getElementById('appContent');
    var overlayLogo = overlay && overlay.querySelector('.loading-overlay__logo');
    if (overlayLogo) overlayLogo.remove();
    if (content) {
      var strayLogo = content.querySelector(':scope > img[src*="/housephotos/logos/logo-black-transparent.png"]');
      if (strayLogo) strayLogo.remove();
    }
    if (overlay) overlay.style.display = 'none';
    if (content) content.classList.remove('hidden');

    // Pre-render header shell with sized logo images.
    // Explicit width/height attributes prevent the images from ever rendering
    // at their natural size (319x453 / 512x512) during the brief window before
    // CSS applies .aap-header__icon { height: 30px }.
    var header = document.getElementById('siteHeader');
    if (header && !header.children.length) {
      var logoBase = 'YOUR_SUPABASE_URL/storage/v1/object/public/housephotos/logos';
      header.innerHTML =
        '<header class="aap-header aap-header--solid aap-header--dark" id="aap-header">' +
          '<div class="aap-header__inner">' +
            '<a href="/" class="aap-header__logo">' +
              '<img src="' + logoBase + '/logo-black-transparent.png" alt="" class="aap-header__icon" width="21" height="30" style="height:30px;width:auto;max-width:none">' +
              '<img src="' + logoBase + '/wordmark-black-transparent.png" alt="YOUR_PROPERTY_NAME" class="aap-header__wordmark" width="22" height="22" style="height:22px;width:auto;max-width:none">' +
            '</a>' +
            '<div id="aapHeaderAuth" class="aap-header-auth"></div>' +
          '</div>' +
        '</header>';
    }
  } catch (e) { /* silent — first-time visitors or corrupt cache just see the normal spinner */ }
})();
