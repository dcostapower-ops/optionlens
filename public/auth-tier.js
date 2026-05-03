/* ═══════════════════════════════════════════════════════════════════
 * StockVizor — auth-tier.js
 * Shared tier/feature helpers. Single source of truth.
 *
 * Consumed by: v.html (dashboard).
 * (s.html will be migrated to consume this in a separate session.)
 *
 * Pure functions — no globals, no DOM access (except showUpgradePrompt).
 * Pass in the data each function needs explicitly.
 *
 * Usage:
 *   const { features, limits } = await SVTier.loadTierFeatures(_sb, AUTH.tier);
 *   if (SVTier.hasFeature(features, 'dashboard.pro_terminal_view')) { ... }
 *   if (!SVTier.hasFeature(features, 'dashboard.pro_terminal_view')) {
 *     SVTier.showUpgradePrompt('Pro Terminal View', AUTH.tier);
 *   }
 * ═══════════════════════════════════════════════════════════════════ */

(function (global) {
  'use strict';

  /**
   * Load the tier's features + limits from subscription_tiers table.
   * Returns { features, limits } — both objects, never null.
   */
  async function loadTierFeatures(_sb, tierId) {
    if (!_sb || !tierId) return { features: {}, limits: {} };
    try {
      const { data, error } = await _sb
        .from('subscription_tiers')
        .select('features, limits')
        .eq('id', tierId)
        .single();
      if (error) {
        console.warn('[auth-tier] load err:', error.message);
        return { features: {}, limits: {} };
      }
      return {
        features: data?.features || {},
        limits: data?.limits || {},
      };
    } catch (e) {
      console.warn('[auth-tier] load exception:', e);
      return { features: {}, limits: {} };
    }
  }

  /**
   * Check if a feature is enabled. Supports nested dotted paths
   * like 'dashboard.pro_terminal_view' or 'chart.pro_chart'.
   * Returns true only if the leaf value is === true.
   */
  function hasFeature(features, key) {
    if (!features || !key) return false;
    // Flat key fast-path
    if (features[key] === true) return true;
    // Nested path traversal
    const parts = key.split('.');
    let v = features;
    for (const p of parts) {
      if (v == null || typeof v !== 'object') return false;
      v = v[p];
    }
    return v === true;
  }

  /**
   * Get a numeric limit (e.g., watchlist_max). Returns 0 if undefined.
   */
  function getLimit(limits, key) {
    if (!limits || !key) return 0;
    return limits[key] ?? 0;
  }

  /**
   * Check if a timeframe (e.g., '5', '60', 'D') is allowed by tier.
   * If features.timeframes is missing, assume no restriction.
   */
  function hasTF(features, tf) {
    const allowed = features?.timeframes;
    if (!allowed || !Array.isArray(allowed)) return true;
    return allowed.includes(String(tf));
  }

  /**
   * Show an upgrade prompt modal. The prompt is built dynamically
   * and inserted into the DOM. Caller passes a feature label and
   * the user's current tier.
   *
   * Hierarchy: free → pro → premium. Determines which tier(s) to
   * suggest as upgrade target.
   */
  function showUpgradePrompt(featureLabel, currentTier) {
    // Remove any existing prompt
    const existing = document.getElementById('svUpgradePrompt');
    if (existing) existing.remove();

    let targetTier, targetColor;
    if (currentTier === 'pro') {
      targetTier = 'Premium';
      targetColor = '#8b5cf6';
    } else {
      // free or unknown → suggest premium since pro_terminal_view is premium-only
      targetTier = 'Premium';
      targetColor = '#8b5cf6';
    }

    const m = document.createElement('div');
    m.id = 'svUpgradePrompt';
    m.style.cssText =
      'position:fixed;inset:0;background:rgba(0,0,0,0.75);z-index:9999;' +
      'display:flex;align-items:center;justify-content:center;font-family:system-ui,Segoe UI,sans-serif;';
    m.innerHTML = `
      <div style="background:#0e1525;border:1px solid #1e2d45;border-radius:10px;
                  padding:28px;max-width:400px;width:90%;text-align:center;
                  box-shadow:0 12px 40px rgba(0,0,0,0.6);">
        <div style="font-size:32px;margin-bottom:12px;">🔒</div>
        <div style="font-size:17px;font-weight:700;color:#e2e8f0;margin-bottom:8px;">
          ${featureLabel} is a ${targetTier} feature
        </div>
        <div style="font-size:13px;color:#9ab0c4;margin-bottom:18px;line-height:1.5;">
          Upgrade your subscription to unlock this feature.
        </div>
        <button id="svUpgradeBtn" style="width:100%;padding:11px;border:none;border-radius:6px;
                background:${targetColor};color:#fff;font-size:13px;font-weight:700;
                cursor:pointer;margin-bottom:8px;">
          Upgrade to ${targetTier}
        </button>
        <button id="svUpgradeCancel" style="width:100%;padding:8px;border:1px solid #2d3d5a;
                background:transparent;color:#9ab0c4;font-size:12px;cursor:pointer;
                border-radius:6px;">
          Maybe Later
        </button>
      </div>
    `;
    document.body.appendChild(m);
    document.getElementById('svUpgradeBtn').addEventListener('click', function () {
      // Placeholder — actual upgrade flow is admin-managed for now
      alert('Contact info@stockvizor.com to upgrade your subscription.');
      m.remove();
    });
    document.getElementById('svUpgradeCancel').addEventListener('click', function () {
      m.remove();
    });
  }

  /**
   * Combined: check feature, and if missing, show upgrade prompt.
   * Returns true if user has access, false otherwise (and shows the prompt).
   */
  function requireTier(features, currentTier, key, label) {
    if (hasFeature(features, key)) return true;
    showUpgradePrompt(label || key, currentTier);
    return false;
  }

  /* Tier UI helpers */
  function tierLabel(tier) {
    if (tier === 'premium') return '◆ Premium';
    if (tier === 'pro') return '✦ Pro';
    return 'Free';
  }
  function tierColor(tier) {
    if (tier === 'premium') return '#8b5cf6';
    if (tier === 'pro') return '#3b82f6';
    return '#9ab0c4';
  }

  // Expose as namespaced global
  global.SVTier = {
    loadTierFeatures,
    hasFeature,
    hasTF,
    getLimit,
    requireTier,
    showUpgradePrompt,
    tierLabel,
    tierColor,
  };
})(window);
