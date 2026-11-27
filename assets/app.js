/**
 * SkyeFlare.com — Client Application Engine (ES6+ Vanilla JS)
 * Handles live deal hydration, Smart Filter & AI Recommendation engine,
 * Intro/Renewal comparison matrix, 12/24/36-month True Cost Calculator,
 * Coupons directory filtering, Contact form validation, and GDPR consent.
 */

const DATA_URLS = ['/data/hosting-deals.json', './data/hosting-deals.json'];
const CONSENT_STORAGE_KEY = 'skyeflare_cookie_consent_v1';

const state = {
  data: null,
  priceMode: 'intro', // 'intro' | 'renewal'
  sortBy: 'tco36', // 'intro' | 'tco36' | 'renewal' | 'multiplier'
  filters: {
    siteType: 'all',
    budget: 'all',
    freeDomain: false,
    freeSsl: false,
    freeMigration: false,
    monthlyBilling: false,
  },
  calc: {
    providerId: 'hostinger',
    planIndex: 0,
    horizonMonths: 36,
    includeDomain: true,
  },
  couponFilter: {
    provider: 'all',
    promoType: 'all',
  },
};

/* ---------- Formatting & Math Utilities ---------- */

function formatCurrency(value) {
  return `$${Number(value).toFixed(2)}`;
}

function formatDateReadable(isoString) {
  if (!isoString) return 'Updated daily';
  const date = new Date(isoString);
  if (Number.isNaN(date.getTime())) return 'Updated daily';
  return date.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  }) + ' UTC';
}

function computePlanTCO(plan, horizonMonths, includeDomainRenewal, avgDomainYearly = 18.99) {
  const term = Math.max(1, Number(plan.billingTermMonths) || 12);
  const introRate = Number(plan.introPriceMonthly);
  const renewalRate = Number(plan.renewalPriceMonthly);

  const introMonths = Math.min(horizonMonths, term);
  const renewalMonths = Math.max(0, horizonMonths - term);

  const introCost = introMonths * introRate;
  const renewalCost = renewalMonths * renewalRate;
  const upfrontCheckout = introRate * term;

  const totalYears = Math.ceil(horizonMonths / 12);
  const paidDomainYears = plan.freeDomain ? Math.max(0, totalYears - 1) : totalYears;
  const domainCost = includeDomainRenewal ? paidDomainYears * avgDomainYearly : 0;

  const totalCost = introCost + renewalCost + domainCost;
  const effectiveMonthly = totalCost / horizonMonths;
  const renewalMultiplier = introRate > 0 ? renewalRate / introRate : 1;

  return {
    horizonMonths,
    introMonths,
    renewalMonths,
    introCost,
    renewalCost,
    domainCost,
    upfrontCheckout,
    totalCost,
    effectiveMonthly,
    renewalMultiplier,
  };
}

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/* ---------- Toast & Clipboard ---------- */

let toastTimer = null;

function showToast(message) {
  let toast = document.getElementById('sf-toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'sf-toast';
    toast.setAttribute('role', 'status');
    toast.setAttribute('aria-live', 'polite');
    toast.className =
      'fixed bottom-5 right-5 z-50 max-w-sm rounded-lg border border-slate-700 bg-slate-900 px-4 py-3 text-sm font-medium text-white shadow-lg sf-transition';
    document.body.appendChild(toast);
  }
  toast.textContent = message;
  requestAnimationFrame(() => {
    toast.classList.add('is-visible');
  });
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toast.classList.remove('is-visible');
  }, 3000);
}

async function copyPromoCode(code, providerName) {
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(code);
    } else {
      const temp = document.createElement('textarea');
      temp.value = code;
      temp.setAttribute('readonly', '');
      temp.style.position = 'absolute';
      temp.style.left = '-9999px';
      document.body.appendChild(temp);
      temp.select();
      document.execCommand('copy');
      document.body.removeChild(temp);
    }
    showToast(`Copied ${providerName} code "${code}" to clipboard.`);
  } catch {
    showToast(`Promo code for ${providerName}: ${code}`);
  }
}

/* ---------- Data Loader ---------- */

async function loadDealsData() {
  for (const url of DATA_URLS) {
    try {
      const response = await fetch(url, { cache: 'no-cache' });
      if (response.ok) {
        const json = await response.json();
        if (json && Array.isArray(json.providers)) {
          return json;
        }
      }
    } catch {
      // Try next fallback URL
    }
  }
  throw new Error('Unable to load hosting deals registry.');
}

function hydrateLastUpdatedLabels(lastUpdated) {
  const readable = formatDateReadable(lastUpdated);
  document.querySelectorAll('[data-last-updated]').forEach((el) => {
    el.textContent = readable;
  });
}

/* ---------- Mobile Navigation ---------- */

function initMobileNav() {
  const btn = document.getElementById('mobile-menu-btn');
  const panel = document.getElementById('mobile-menu-panel');
  if (!btn || !panel) return;

  btn.addEventListener('click', () => {
    const isExpanded = btn.getAttribute('aria-expanded') === 'true';
    btn.setAttribute('aria-expanded', String(!isExpanded));
    panel.classList.toggle('hidden', isExpanded);
  });
}

/* ---------- GDPR Cookie Consent Banner & Modal ---------- */

function getSavedConsent() {
  try {
    const raw = localStorage.getItem(CONSENT_STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function saveConsent(consent) {
  const payload = {
    essential: true,
    analytics: Boolean(consent.analytics),
    advertising: Boolean(consent.advertising),
    updatedAt: new Date().toISOString(),
  };
  try {
    localStorage.setItem(CONSENT_STORAGE_KEY, JSON.stringify(payload));
  } catch {
    // Ignore storage quota errors
  }
  return payload;
}

function initCookieConsent() {
  const existing = getSavedConsent();

  // Inject lightweight bottom consent banner if not yet saved
  let banner = document.getElementById('sf-cookie-banner');
  if (!banner) {
    banner = document.createElement('aside');
    banner.id = 'sf-cookie-banner';
    banner.setAttribute('aria-label', 'Cookie preferences');
    banner.className =
      'fixed bottom-0 inset-x-0 z-40 border-t border-slate-200 bg-white/95 backdrop-blur px-4 py-3 shadow-sm';
    banner.innerHTML = `
      <div class="mx-auto flex max-w-6xl flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <p class="text-xs leading-relaxed text-slate-600">
          SkyeFlare uses essential cookies to remember your preferences and supports programmatic advertising partners (such as RevBid).
          <a href="/privacy-policy.html" class="font-medium text-indigo-700 underline underline-offset-2 hover:text-indigo-800">Privacy Policy</a>.
        </p>
        <div class="flex flex-wrap items-center gap-2 shrink-0">
          <button type="button" id="sf-cookie-manage" class="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 sf-transition whitespace-nowrap">
            Manage
          </button>
          <button type="button" id="sf-cookie-essential" class="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 sf-transition whitespace-nowrap">
            Essential Only
          </button>
          <button type="button" id="sf-cookie-accept" class="rounded-md bg-indigo-700 px-3.5 py-1.5 text-xs font-medium text-white hover:bg-indigo-800 sf-transition whitespace-nowrap">
            Accept All
          </button>
        </div>
      </div>
    `;
    document.body.appendChild(banner);
  }

  if (existing) {
    banner.classList.add('hidden');
  }

  // Preferences Modal
  let modal = document.getElementById('sf-cookie-modal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'sf-cookie-modal';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('aria-labelledby', 'sf-cookie-modal-title');
    modal.className =
      'fixed inset-0 z-50 hidden flex items-center justify-center bg-slate-900/50 p-4';
    modal.innerHTML = `
      <div class="w-full max-w-md rounded-xl border border-slate-200 bg-white p-6 shadow-xl">
        <div class="flex items-start justify-between gap-4">
          <h2 id="sf-cookie-modal-title" class="text-lg font-semibold text-slate-900">Cookie &amp; Ad Preferences</h2>
          <button type="button" id="sf-cookie-close" aria-label="Close preferences" class="rounded-md p-1 text-slate-500 hover:bg-slate-100 hover:text-slate-900">
            <svg class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12"/></svg>
          </button>
        </div>
        <p class="mt-2 text-sm text-slate-600">Control how SkyeFlare stores local preferences and works with analytics or ad partners.</p>
        <div class="mt-4 divide-y divide-slate-200 border-y border-slate-200">
          <div class="flex items-center justify-between py-3">
            <div>
              <div class="text-sm font-medium text-slate-900">Essential Functional Storage</div>
              <div class="text-xs text-slate-500">Stores your consent status and calculator settings.</div>
            </div>
            <span class="text-xs font-medium text-slate-500">Always active</span>
          </div>
          <label class="flex cursor-pointer items-center justify-between py-3">
            <div>
              <div class="text-sm font-medium text-slate-900">Privacy-First Analytics</div>
              <div class="text-xs text-slate-500">Aggregate page performance and broken-link telemetry.</div>
            </div>
            <input type="checkbox" id="sf-pref-analytics" class="h-4 w-4 rounded border-slate-300 text-indigo-700 focus:ring-indigo-600" />
          </label>
          <label class="flex cursor-pointer items-center justify-between py-3">
            <div>
              <div class="text-sm font-medium text-slate-900">Advertising Partners (RevBid)</div>
              <div class="text-xs text-slate-500">Supports free hosting comparison tools via non-intrusive ads.</div>
            </div>
            <input type="checkbox" id="sf-pref-advertising" class="h-4 w-4 rounded border-slate-300 text-indigo-700 focus:ring-indigo-600" />
          </label>
        </div>
        <div class="mt-5 flex justify-end gap-2">
          <button type="button" id="sf-cookie-save-prefs" class="rounded-md bg-indigo-700 px-4 py-2 text-xs font-medium text-white hover:bg-indigo-800 sf-transition">
            Save Preferences
          </button>
        </div>
      </div>
    `;
    document.body.appendChild(modal);
  }

  const openModal = () => {
    const current = getSavedConsent() || { analytics: true, advertising: true };
    const analyticsBox = document.getElementById('sf-pref-analytics');
    const adsBox = document.getElementById('sf-pref-advertising');
    if (analyticsBox) analyticsBox.checked = Boolean(current.analytics);
    if (adsBox) adsBox.checked = Boolean(current.advertising);
    modal.classList.remove('hidden');
  };

  const closeModal = () => {
    modal.classList.add('hidden');
  };

  document.getElementById('sf-cookie-accept')?.addEventListener('click', () => {
    saveConsent({ analytics: true, advertising: true });
    banner.classList.add('hidden');
    showToast('Cookie preferences saved.');
  });

  document.getElementById('sf-cookie-essential')?.addEventListener('click', () => {
    saveConsent({ analytics: false, advertising: false });
    banner.classList.add('hidden');
    showToast('Saved: Essential storage only.');
  });

  document.getElementById('sf-cookie-manage')?.addEventListener('click', openModal);
  document.getElementById('sf-cookie-close')?.addEventListener('click', closeModal);

  document.getElementById('sf-cookie-save-prefs')?.addEventListener('click', () => {
    const analytics = Boolean(document.getElementById('sf-pref-analytics')?.checked);
    const advertising = Boolean(document.getElementById('sf-pref-advertising')?.checked);
    saveConsent({ analytics, advertising });
    closeModal();
    banner.classList.add('hidden');
    showToast('Cookie preferences updated.');
  });

  // Footer / Privacy Policy trigger buttons
  document.querySelectorAll('[data-open-cookie-settings]').forEach((trigger) => {
    trigger.addEventListener('click', (e) => {
      e.preventDefault();
      openModal();
    });
  });
}

/* ---------- Home Page: Smart Filter & AI Recommendation ---------- */

function providerMatchesFilters(provider, filters) {
  if (filters.siteType !== 'all' && !provider.bestFor.includes(filters.siteType)) {
    return false;
  }
  const intro = provider.introPriceMonthly;
  if (filters.budget === 'low' && intro > 3.0) return false;
  if (filters.budget === 'mid' && (intro <= 3.0 || intro > 7.0)) return false;
  if (filters.budget === 'high' && intro <= 7.0) return false;

  if (filters.freeDomain && !provider.freeDomain) return false;
  if (filters.freeSsl && !provider.freeSsl) return false;
  if (filters.freeMigration && !provider.freeMigration) return false;
  if (filters.monthlyBilling && !provider.monthlyBillingAvailable) return false;

  return true;
}

function scoreRecommendation(provider, filters) {
  const avgDom = state.data?.averageDomainRenewalYearly || 18.99;
  const tco36 = computePlanTCO(provider, 36, true, avgDom).totalCost;
  // Lower 36-month TCO and lower renewal spike earn higher priority
  let score = 1000 - tco36;
  if (filters.siteType !== 'all' && provider.bestFor[0] === filters.siteType) {
    score += 45;
  }
  if (provider.renewalPriceMonthly === provider.introPriceMonthly) {
    score += 30; // Flat renewal transparency bonus
  }
  if (provider.freeDomain) score += 20;
  return score;
}

function buildRecommendationReason(provider, tco36, filters) {
  const parts = [];
  if (filters.siteType !== 'all') {
    const labels = {
      wordpress: 'WordPress blogs',
      woocommerce: 'WooCommerce stores',
      portfolio: 'portfolio sites',
      agency: 'agency & cloud VPS workloads',
    };
    parts.push(`Engineered for ${labels[filters.siteType] || filters.siteType}`);
  }
  if (provider.renewalPriceMonthly === provider.introPriceMonthly) {
    parts.push(`flat ${formatCurrency(provider.introPriceMonthly)}/mo rate with zero renewal jump`);
  } else {
    parts.push(
      `delivers ${formatCurrency(tco36.totalCost)} total 36-month cost (${formatCurrency(tco36.effectiveMonthly)}/mo blended)`
    );
  }
  if (provider.freeDomain) {
    parts.push('includes a free 1st-year domain');
  }
  return `${parts.join(' and ')}.`;
}

function renderPromoActionHtml(provider, compact = false) {
  const pad = compact ? 'px-3 py-1.5 text-xs' : 'px-4 py-2 text-xs';
  const isExpired = String(provider.status || '').toLowerCase() === 'expired';
  if (isExpired) {
    return `
      <div class="flex flex-wrap items-center gap-2">
        <span class="inline-flex items-center rounded-md border border-red-200 bg-red-50 ${pad} font-mono font-medium text-red-700 line-through cursor-not-allowed whitespace-nowrap shrink-0">
          ${escapeHtml(provider.promoCode || 'Expired')}
        </span>
        <a
          href="${escapeHtml(provider.officialOfferUrl)}"
          target="_blank"
          rel="noopener noreferrer nofollow"
          class="inline-flex items-center rounded-md border border-slate-300 bg-white ${pad} font-medium text-slate-700 hover:bg-slate-50 sf-transition whitespace-nowrap shrink-0"
        >
          Check Current Rate
        </a>
      </div>
    `;
  }
  if (provider.promoType === 'promo_code' && provider.promoCode) {
    return `
      <div class="flex flex-wrap items-center gap-2">
        <button
          type="button"
          data-copy-code="${escapeHtml(provider.promoCode)}"
          data-provider-name="${escapeHtml(provider.name)}"
          class="inline-flex items-center gap-1.5 rounded-md border border-indigo-200 bg-indigo-50 ${pad} font-mono font-semibold text-indigo-800 hover:bg-indigo-100 sf-transition whitespace-nowrap shrink-0"
        >
          <span>Copy: ${escapeHtml(provider.promoCode)}</span>
        </button>
        <a
          href="${escapeHtml(provider.officialOfferUrl)}"
          target="_blank"
          rel="noopener noreferrer nofollow"
          class="inline-flex items-center rounded-md bg-indigo-700 ${pad} font-medium text-white hover:bg-indigo-800 sf-transition whitespace-nowrap shrink-0"
        >
          Activate Deal
        </a>
      </div>
    `;
  }
  return `
    <a
      href="${escapeHtml(provider.officialOfferUrl)}"
      target="_blank"
      rel="noopener noreferrer nofollow"
      class="inline-flex items-center rounded-md bg-indigo-700 ${pad} font-medium text-white hover:bg-indigo-800 sf-transition whitespace-nowrap shrink-0"
    >
      Activate Auto-Deal
    </a>
  `;
}

function renderRecommendationResult() {
  const container = document.getElementById('ai-recommendation-output');
  if (!container || !state.data) return;

  const avgDom = state.data.averageDomainRenewalYearly || 18.99;
  const matches = state.data.providers.filter((p) => providerMatchesFilters(p, state.filters));

  if (matches.length === 0) {
    container.innerHTML = `
      <div class="rounded-lg border border-slate-200 bg-slate-50 p-6">
        <div class="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h3 class="text-base font-semibold text-slate-900">No single host matches every selected constraint</h3>
            <p class="mt-1 text-sm text-slate-600">
              For example, no provider combines a $1–$3/mo intro rate with true no-lock-in monthly billing and a free .com domain. Clear one must-have filter to inspect closest matches.
            </p>
          </div>
          <button
            type="button"
            id="sf-reset-filters-inline"
            class="rounded-md bg-slate-900 px-4 py-2 text-xs font-medium text-white hover:bg-slate-800 sf-transition whitespace-nowrap shrink-0"
          >
            Reset Filters
          </button>
        </div>
      </div>
    `;
    document.getElementById('sf-reset-filters-inline')?.addEventListener('click', resetAllFilters);
    return;
  }

  const ranked = [...matches].sort(
    (a, b) => scoreRecommendation(b, state.filters) - scoreRecommendation(a, state.filters)
  );
  const top = ranked[0];
  const runnerUp = ranked[1] || null;

  const top12 = computePlanTCO(top, 12, true, avgDom);
  const top36 = computePlanTCO(top, 36, true, avgDom);

  container.innerHTML = `
    <div class="grid gap-4 lg:grid-cols-3">
      <div class="lg:col-span-2 rounded-lg border border-indigo-200 bg-white p-5">
        <div class="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 pb-3">
          <div class="flex items-center gap-2 text-xs text-slate-500">
            <span class="font-semibold text-indigo-700">Top Value Match (${matches.length} of ${state.data.providers.length} matched)</span>
            <span aria-hidden="true">&middot;</span>
            <span>${escapeHtml(top.category)}</span>
            <span aria-hidden="true">&middot;</span>
            <span>${escapeHtml(top.promoBadgeText)}</span>
          </div>
          <span class="font-mono text-xs text-slate-500 tabular-nums">${escapeHtml(top.guaranteeLabel)}</span>
        </div>

        <div class="mt-4 flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <h3 class="text-xl font-bold text-slate-900">${escapeHtml(top.name)} &mdash; ${escapeHtml(top.planName)}</h3>
            <p class="mt-1 text-sm leading-relaxed text-slate-600">${escapeHtml(buildRecommendationReason(top, top36, state.filters))}</p>
            <p class="mt-2 text-xs text-slate-500">${escapeHtml(top.promoHeadline)}</p>
          </div>
          <div class="shrink-0 sm:text-right">
            <div class="font-mono text-2xl font-bold text-slate-900 tabular-nums">${formatCurrency(top.introPriceMonthly)}<span class="text-xs font-normal text-slate-500">/mo intro</span></div>
            <div class="font-mono text-xs text-slate-500 tabular-nums">Renews at ${formatCurrency(top.renewalPriceMonthly)}/mo (${top.billingTermMonths}-mo term)</div>
          </div>
        </div>

        <div class="mt-4 grid grid-cols-2 gap-3 border-t border-slate-100 pt-4 sm:grid-cols-4">
          <div>
            <div class="text-xs text-slate-500">12-Mo Real Cost</div>
            <div class="font-mono text-sm font-semibold text-slate-900 tabular-nums">${formatCurrency(top12.totalCost)}</div>
          </div>
          <div>
            <div class="text-xs text-slate-500">36-Mo Real Cost</div>
            <div class="font-mono text-sm font-semibold text-slate-900 tabular-nums">${formatCurrency(top36.totalCost)}</div>
          </div>
          <div>
            <div class="text-xs text-slate-500">Storage / Sites</div>
            <div class="text-sm font-medium text-slate-900">${escapeHtml(top.storage)} &middot; ${escapeHtml(top.websites)}</div>
          </div>
          <div>
            <div class="text-xs text-slate-500">Free Domain</div>
            <div class="text-sm font-medium ${top.freeDomain ? 'text-emerald-700' : 'text-slate-700'}">${top.freeDomain ? 'Included (Yr 1)' : 'Not bundled'}</div>
          </div>
        </div>

        <div class="mt-5 flex flex-wrap items-center justify-between gap-3">
          ${renderPromoActionHtml(top)}
          <button
            type="button"
            data-load-calculator="${escapeHtml(top.id)}"
            class="text-xs font-medium text-indigo-700 hover:text-indigo-900 underline underline-offset-2 whitespace-nowrap"
          >
            Inspect in Cost Calculator &rarr;
          </button>
        </div>
      </div>

      <div class="rounded-lg border border-slate-200 bg-slate-50 p-5 flex flex-col justify-between">
        ${
          runnerUp
            ? (() => {
                const ru36 = computePlanTCO(runnerUp, 36, true, avgDom);
                return `
                  <div>
                    <div class="text-xs font-medium text-slate-500">Strong Alternative</div>
                    <h4 class="mt-1 text-base font-bold text-slate-900">${escapeHtml(runnerUp.name)} &mdash; ${escapeHtml(runnerUp.planName)}</h4>
                    <p class="mt-1 text-xs leading-relaxed text-slate-600">${escapeHtml(runnerUp.promoTerms)}</p>
                    <div class="mt-4 space-y-2 border-t border-slate-200 pt-3 text-xs">
                      <div class="flex justify-between">
                        <span class="text-slate-500">Intro Rate</span>
                        <span class="font-mono font-semibold text-slate-900 tabular-nums">${formatCurrency(runnerUp.introPriceMonthly)}/mo</span>
                      </div>
                      <div class="flex justify-between">
                        <span class="text-slate-500">Renewal Rate</span>
                        <span class="font-mono font-semibold text-slate-900 tabular-nums">${formatCurrency(runnerUp.renewalPriceMonthly)}/mo</span>
                      </div>
                      <div class="flex justify-between">
                        <span class="text-slate-500">36-Mo Blended Total</span>
                        <span class="font-mono font-semibold text-slate-900 tabular-nums">${formatCurrency(ru36.totalCost)}</span>
                      </div>
                    </div>
                  </div>
                  <div class="mt-4 pt-3 border-t border-slate-200 flex items-center justify-between gap-2">
                    <a href="${escapeHtml(runnerUp.officialOfferUrl)}" target="_blank" rel="noopener noreferrer nofollow" class="text-xs font-semibold text-indigo-700 hover:text-indigo-900">
                      View ${escapeHtml(runnerUp.name)} Deal &rarr;
                    </a>
                    <button type="button" data-load-calculator="${escapeHtml(runnerUp.id)}" class="text-xs text-slate-600 hover:text-slate-900 underline">
                      Calculate
                    </button>
                  </div>
                `;
              })()
            : `
                <div>
                  <div class="text-xs font-medium text-slate-500">Exact Single Match</div>
                  <p class="mt-2 text-sm text-slate-600">Only ${escapeHtml(top.name)} meets every constraint selected above.</p>
                </div>
                <button type="button" id="sf-reset-filters-side" class="mt-4 rounded-md border border-slate-300 bg-white px-3 py-2 text-xs font-medium text-slate-700 hover:bg-slate-100">
                  Show All 8 Providers
                </button>
              `
        }
      </div>
    </div>
  `;

  document.getElementById('sf-reset-filters-side')?.addEventListener('click', resetAllFilters);
  bindDynamicActionButtons(container);
}

function resetAllFilters() {
  state.filters = {
    siteType: 'all',
    budget: 'all',
    freeDomain: false,
    freeSsl: false,
    freeMigration: false,
    monthlyBilling: false,
  };
  const siteSelect = document.getElementById('filter-site-type');
  const budgetSelect = document.getElementById('filter-budget');
  if (siteSelect) siteSelect.value = 'all';
  if (budgetSelect) budgetSelect.value = 'all';

  ['freeDomain', 'freeSsl', 'freeMigration', 'monthlyBilling'].forEach((key) => {
    const box = document.getElementById(`filter-${key}`);
    if (box) box.checked = false;
  });

  renderRecommendationResult();
  renderComparisonTable();
}

/* ---------- Home Page: Interactive Comparison Table ---------- */

function getSortedProviders(list) {
  const avgDom = state.data?.averageDomainRenewalYearly || 18.99;
  return [...list].sort((a, b) => {
    if (state.sortBy === 'intro') {
      return a.introPriceMonthly - b.introPriceMonthly;
    }
    if (state.sortBy === 'renewal') {
      return a.renewalPriceMonthly - b.renewalPriceMonthly;
    }
    if (state.sortBy === 'multiplier') {
      return a.renewalPriceMonthly / a.introPriceMonthly - b.renewalPriceMonthly / b.introPriceMonthly;
    }
    // default 'tco36'
    return (
      computePlanTCO(a, 36, true, avgDom).totalCost -
      computePlanTCO(b, 36, true, avgDom).totalCost
    );
  });
}

function renderComparisonTable() {
  const tbody = document.getElementById('comparison-table-body');
  const mobileCards = document.getElementById('comparison-mobile-cards');
  const countLabel = document.getElementById('comparison-match-count');
  if (!tbody || !mobileCards || !state.data) return;

  const avgDom = state.data.averageDomainRenewalYearly || 18.99;
  const filtered = state.data.providers.filter((p) => providerMatchesFilters(p, state.filters));
  const sorted = getSortedProviders(filtered);

  if (countLabel) {
    countLabel.textContent = `Showing ${sorted.length} of ${state.data.providers.length} providers`;
  }

  if (sorted.length === 0) {
    const emptyHtml = `
      <div class="rounded-lg border border-slate-200 bg-white p-8 text-center">
        <p class="text-sm font-medium text-slate-900">No providers match your current filter combination.</p>
        <p class="mt-1 text-xs text-slate-500">Reset filters to compare all 8 hosting providers side-by-side.</p>
        <button type="button" id="sf-table-reset" class="mt-4 rounded-md bg-indigo-700 px-4 py-2 text-xs font-medium text-white hover:bg-indigo-800">
          Reset All Filters
        </button>
      </div>
    `;
    tbody.innerHTML = `<tr><td colspan="7" class="p-6">${emptyHtml}</td></tr>`;
    mobileCards.innerHTML = emptyHtml;
    document.querySelectorAll('#sf-table-reset').forEach((btn) => btn.addEventListener('click', resetAllFilters));
    return;
  }

  const isRenewalView = state.priceMode === 'renewal';

  tbody.innerHTML = sorted
    .map((p) => {
      const tco36 = computePlanTCO(p, 36, true, avgDom);
      const mult = (p.renewalPriceMonthly / p.introPriceMonthly).toFixed(1);
      const displayPrice = isRenewalView ? p.renewalPriceMonthly : p.introPriceMonthly;
      const secondaryPrice = isRenewalView
        ? `Intro: ${formatCurrency(p.introPriceMonthly)}/mo (${p.billingTermMonths} mo)`
        : `Renews: ${formatCurrency(p.renewalPriceMonthly)}/mo (${mult}×)`;

      return `
        <tr class="border-b border-slate-200 hover:bg-slate-50/80 sf-transition">
          <td class="py-4 pl-4 pr-3 align-top">
            <div class="flex items-center gap-3">
              <div class="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-slate-200 bg-slate-900 font-mono text-xs font-bold text-white" style="background-color: ${escapeHtml(p.accentColor)}">
                ${escapeHtml(p.monogram)}
              </div>
              <div>
                <div class="font-semibold text-slate-900">${escapeHtml(p.name)}</div>
                <div class="text-xs text-slate-500">${escapeHtml(p.planName)} &middot; ${escapeHtml(p.controlPanel)}</div>
              </div>
            </div>
          </td>
          <td class="px-3 py-4 align-top">
            <div class="font-mono text-base font-bold text-slate-900 tabular-nums">${formatCurrency(displayPrice)}<span class="text-xs font-normal text-slate-500">/mo</span></div>
            <div class="mt-0.5 font-mono text-xs ${isRenewalView ? 'text-slate-500' : p.renewalPriceMonthly > p.introPriceMonthly * 2 ? 'text-amber-700' : 'text-slate-500'} tabular-nums">
              ${escapeHtml(secondaryPrice)}
            </div>
          </td>
          <td class="px-3 py-4 align-top">
            <div class="font-mono text-sm font-semibold text-slate-900 tabular-nums">${formatCurrency(tco36.totalCost)}</div>
            <div class="mt-0.5 font-mono text-xs text-slate-500 tabular-nums">${formatCurrency(tco36.effectiveMonthly)}/mo avg</div>
          </td>
          <td class="px-3 py-4 align-top text-xs text-slate-700">
            <div class="font-medium text-slate-900">${escapeHtml(p.storage)}</div>
            <div class="text-slate-500">${escapeHtml(p.websites)}</div>
          </td>
          <td class="px-3 py-4 align-top text-xs">
            <div class="font-medium ${p.freeDomain ? 'text-emerald-700' : 'text-slate-700'}">
              ${p.freeDomain ? 'Free 1st Year' : 'Not Included'}
            </div>
            <div class="mt-0.5 text-slate-500">${escapeHtml(p.guaranteeLabel)}</div>
          </td>
          <td class="px-3 py-4 align-top text-xs">
            <div class="font-medium text-slate-900">${escapeHtml(p.promoBadgeText)}</div>
            <div class="mt-0.5 max-w-[210px] text-slate-500">${p.promoType === 'promo_code' && p.promoCode ? `Code: ${escapeHtml(p.promoCode)}` : 'Applied on offer link'}</div>
          </td>
          <td class="py-4 pl-3 pr-4 align-top text-right">
            <div class="flex flex-col items-end gap-1.5">
              ${renderPromoActionHtml(p, true)}
              <button type="button" data-load-calculator="${escapeHtml(p.id)}" class="text-xs text-slate-500 hover:text-indigo-700 underline underline-offset-2">
                Calculate 1–3 yr cost
              </button>
            </div>
          </td>
        </tr>
      `;
    })
    .join('');

  mobileCards.innerHTML = sorted
    .map((p) => {
      const tco36 = computePlanTCO(p, 36, true, avgDom);
      const displayPrice = isRenewalView ? p.renewalPriceMonthly : p.introPriceMonthly;
      return `
        <article class="rounded-lg border border-slate-200 bg-white p-4">
          <div class="flex items-start justify-between gap-3">
            <div class="flex items-center gap-3">
              <div class="flex h-9 w-9 shrink-0 items-center justify-center rounded-md font-mono text-xs font-bold text-white" style="background-color: ${escapeHtml(p.accentColor)}">
                ${escapeHtml(p.monogram)}
              </div>
              <div>
                <h3 class="text-base font-bold text-slate-900">${escapeHtml(p.name)}</h3>
                <p class="text-xs text-slate-500">${escapeHtml(p.planName)} &middot; ${p.billingTermMonths}-mo term</p>
              </div>
            </div>
            <div class="text-right">
              <div class="font-mono text-lg font-bold text-slate-900 tabular-nums">${formatCurrency(displayPrice)}/mo</div>
              <div class="font-mono text-xs text-slate-500 tabular-nums">${isRenewalView ? `Intro ${formatCurrency(p.introPriceMonthly)}` : `Renews ${formatCurrency(p.renewalPriceMonthly)}`}</div>
            </div>
          </div>

          <div class="mt-3 grid grid-cols-2 gap-2 border-y border-slate-100 py-3 text-xs">
            <div>
              <span class="text-slate-500">36-Mo Total:</span>
              <span class="font-mono font-semibold text-slate-900 tabular-nums"> ${formatCurrency(tco36.totalCost)}</span>
            </div>
            <div>
              <span class="text-slate-500">Storage:</span>
              <span class="font-medium text-slate-900"> ${escapeHtml(p.storage)}</span>
            </div>
            <div>
              <span class="text-slate-500">Free Domain:</span>
              <span class="font-medium ${p.freeDomain ? 'text-emerald-700' : 'text-slate-700'}"> ${p.freeDomain ? 'Yes (Yr 1)' : 'No'}</span>
            </div>
            <div>
              <span class="text-slate-500">Guarantee:</span>
              <span class="font-medium text-slate-900"> ${escapeHtml(p.guaranteeLabel)}</span>
            </div>
          </div>

          <p class="mt-3 text-xs text-slate-600">${escapeHtml(p.promoHeadline)}</p>

          <div class="mt-4 flex flex-wrap items-center justify-between gap-2">
            ${renderPromoActionHtml(p, true)}
            <button type="button" data-load-calculator="${escapeHtml(p.id)}" class="text-xs font-medium text-indigo-700 underline">
              Load in Calculator
            </button>
          </div>
        </article>
      `;
    })
    .join('');

  bindDynamicActionButtons(tbody);
  bindDynamicActionButtons(mobileCards);
}

/* ---------- Home Page: 1-Year vs 3-Year True Cost Calculator ---------- */

function renderCalculator() {
  if (!state.data) return;
  const providerSelect = document.getElementById('calc-provider');
  const planSelect = document.getElementById('calc-plan');
  const output = document.getElementById('calc-output');
  const leaderboard = document.getElementById('calc-leaderboard');
  if (!providerSelect || !planSelect || !output) return;

  const provider =
    state.data.providers.find((p) => p.id === state.calc.providerId) || state.data.providers[0];
  const plans = provider.plans && provider.plans.length > 0 ? provider.plans : [provider];
  const safePlanIndex = Math.min(state.calc.planIndex, plans.length - 1);
  const selectedPlan = plans[safePlanIndex];

  // Populate plan selector options for current provider
  planSelect.innerHTML = plans
    .map(
      (pl, idx) =>
        `<option value="${idx}" ${idx === safePlanIndex ? 'selected' : ''}>${escapeHtml(pl.name)} (${formatCurrency(pl.introPriceMonthly)}/mo intro)</option>`
    )
    .join('');

  const avgDom = state.data.averageDomainRenewalYearly || 18.99;
  const includeDom = state.calc.includeDomain;
  const res12 = computePlanTCO(selectedPlan, 12, includeDom, avgDom);
  const res24 = computePlanTCO(selectedPlan, 24, includeDom, avgDom);
  const res36 = computePlanTCO(selectedPlan, 36, includeDom, avgDom);
  const activeRes =
    state.calc.horizonMonths === 12 ? res12 : state.calc.horizonMonths === 24 ? res24 : res36;

  const introPct = activeRes.totalCost > 0 ? (activeRes.introCost / activeRes.totalCost) * 100 : 100;
  const renewalPct =
    activeRes.totalCost > 0 ? (activeRes.renewalCost / activeRes.totalCost) * 100 : 0;
  const domainPct = Math.max(0, 100 - introPct - renewalPct);

  output.innerHTML = `
    <div class="flex flex-wrap items-baseline justify-between gap-4 border-b border-slate-800 pb-5">
      <div>
        <div class="text-xs font-medium text-indigo-300">${escapeHtml(provider.name)} &middot; ${escapeHtml(selectedPlan.name)}</div>
        <div class="mt-1 font-mono text-3xl font-bold text-white tabular-nums sm:text-4xl">${formatCurrency(activeRes.totalCost)}</div>
        <div class="mt-1 text-xs text-slate-400">
          True ${activeRes.horizonMonths}-month cost (${formatCurrency(activeRes.effectiveMonthly)}/mo blended average)
        </div>
      </div>
      <div class="rounded-lg border border-slate-800 bg-slate-900/70 px-4 py-3 text-right">
        <div class="text-xs text-slate-400">Cash due at initial checkout</div>
        <div class="font-mono text-lg font-bold text-white tabular-nums">${formatCurrency(activeRes.upfrontCheckout)}</div>
        <div class="text-xs text-slate-400">Covers first ${selectedPlan.billingTermMonths} month${selectedPlan.billingTermMonths > 1 ? 's' : ''}</div>
      </div>
    </div>

    <div class="mt-5">
      <div class="flex items-center justify-between text-xs text-slate-400">
        <span>Cost composition over ${activeRes.horizonMonths} months</span>
        <span class="font-mono tabular-nums">${activeRes.renewalMultiplier.toFixed(1)}&times; renewal multiplier</span>
      </div>
      <div class="mt-2 flex h-3 w-full overflow-hidden rounded-full bg-slate-800" role="img" aria-label="Introductory vs renewal vs domain cost breakdown">
        <div class="bg-indigo-500" style="width: ${introPct.toFixed(1)}%" title="Intro Hosting"></div>
        <div class="bg-amber-500" style="width: ${renewalPct.toFixed(1)}%" title="Renewal Hosting"></div>
        <div class="bg-emerald-500" style="width: ${domainPct.toFixed(1)}%" title="Domain Registration & Renewals"></div>
      </div>
      <div class="mt-3 grid grid-cols-1 gap-3 text-xs sm:grid-cols-3">
        <div class="rounded-md border border-slate-800 bg-slate-900/50 p-3">
          <div class="flex items-center justify-between">
            <span class="text-slate-400">Intro Hosting (${activeRes.introMonths} mo)</span>
            <span class="inline-block h-2 w-2 rounded-sm bg-indigo-500"></span>
          </div>
          <div class="mt-1 font-mono text-sm font-semibold text-white tabular-nums">${formatCurrency(activeRes.introCost)}</div>
        </div>
        <div class="rounded-md border border-slate-800 bg-slate-900/50 p-3">
          <div class="flex items-center justify-between">
            <span class="text-slate-400">Renewal Hosting (${activeRes.renewalMonths} mo)</span>
            <span class="inline-block h-2 w-2 rounded-sm bg-amber-500"></span>
          </div>
          <div class="mt-1 font-mono text-sm font-semibold text-white tabular-nums">${formatCurrency(activeRes.renewalCost)}</div>
        </div>
        <div class="rounded-md border border-slate-800 bg-slate-900/50 p-3">
          <div class="flex items-center justify-between">
            <span class="text-slate-400">Domain Renewals</span>
            <span class="inline-block h-2 w-2 rounded-sm bg-emerald-500"></span>
          </div>
          <div class="mt-1 font-mono text-sm font-semibold text-white tabular-nums">${formatCurrency(activeRes.domainCost)}</div>
        </div>
      </div>
    </div>

    <div class="mt-5 grid grid-cols-3 gap-3 border-t border-slate-800 pt-5">
      <div class="rounded-md border ${state.calc.horizonMonths === 12 ? 'border-indigo-500 bg-indigo-950/40' : 'border-slate-800 bg-slate-900/40'} p-3">
        <div class="text-xs text-slate-400">12-Month Total</div>
        <div class="mt-1 font-mono text-base font-bold text-white tabular-nums">${formatCurrency(res12.totalCost)}</div>
        <div class="font-mono text-xs text-slate-400 tabular-nums">${formatCurrency(res12.effectiveMonthly)}/mo</div>
      </div>
      <div class="rounded-md border ${state.calc.horizonMonths === 24 ? 'border-indigo-500 bg-indigo-950/40' : 'border-slate-800 bg-slate-900/40'} p-3">
        <div class="text-xs text-slate-400">24-Month Total</div>
        <div class="mt-1 font-mono text-base font-bold text-white tabular-nums">${formatCurrency(res24.totalCost)}</div>
        <div class="font-mono text-xs text-slate-400 tabular-nums">${formatCurrency(res24.effectiveMonthly)}/mo</div>
      </div>
      <div class="rounded-md border ${state.calc.horizonMonths === 36 ? 'border-indigo-500 bg-indigo-950/40' : 'border-slate-800 bg-slate-900/40'} p-3">
        <div class="text-xs text-slate-400">36-Month Total</div>
        <div class="mt-1 font-mono text-base font-bold text-white tabular-nums">${formatCurrency(res36.totalCost)}</div>
        <div class="font-mono text-xs text-slate-400 tabular-nums">${formatCurrency(res36.effectiveMonthly)}/mo</div>
      </div>
    </div>
  `;

  if (leaderboard) {
    const rankedAll = state.data.providers
      .map((p) => ({
        provider: p,
        tco: computePlanTCO(p, state.calc.horizonMonths, includeDom, avgDom),
      }))
      .sort((a, b) => a.tco.totalCost - b.tco.totalCost);

    const maxCost = Math.max(...rankedAll.map((r) => r.tco.totalCost), 1);

    leaderboard.innerHTML = rankedAll
      .map((item, idx) => {
        const isSelected = item.provider.id === provider.id;
        const barWidth = Math.max(8, (item.tco.totalCost / maxCost) * 100);
        return `
          <button
            type="button"
            data-load-calculator="${escapeHtml(item.provider.id)}"
            class="w-full text-left rounded-md px-2.5 py-2 sf-transition ${
              isSelected ? 'bg-slate-800 border border-indigo-500/60' : 'hover:bg-slate-800/60 border border-transparent'
            }"
          >
            <div class="flex items-center justify-between text-xs">
              <span class="font-medium ${isSelected ? 'text-white' : 'text-slate-300'}">${idx + 1}. ${escapeHtml(item.provider.name)}</span>
              <span class="font-mono font-semibold text-white tabular-nums">${formatCurrency(item.tco.totalCost)}</span>
            </div>
            <div class="mt-1.5 h-1.5 w-full rounded-full bg-slate-800">
              <div class="h-1.5 rounded-full ${isSelected ? 'bg-indigo-400' : 'bg-slate-500'}" style="width: ${barWidth.toFixed(1)}%"></div>
            </div>
          </button>
        `;
      })
      .join('');

    bindDynamicActionButtons(leaderboard);
  }
}

function initHomeControls() {
  const providerSelect = document.getElementById('calc-provider');
  if (providerSelect && state.data) {
    providerSelect.innerHTML = state.data.providers
      .map((p) => `<option value="${escapeHtml(p.id)}">${escapeHtml(p.name)}</option>`)
      .join('');
    providerSelect.value = state.calc.providerId;
    providerSelect.addEventListener('change', (e) => {
      state.calc.providerId = e.target.value;
      state.calc.planIndex = 0;
      renderCalculator();
    });
  }

  document.getElementById('calc-plan')?.addEventListener('change', (e) => {
    state.calc.planIndex = Number(e.target.value) || 0;
    renderCalculator();
  });

  document.querySelectorAll('[data-calc-horizon]').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.calc.horizonMonths = Number(btn.getAttribute('data-calc-horizon')) || 36;
      document.querySelectorAll('[data-calc-horizon]').forEach((b) => {
        const active = Number(b.getAttribute('data-calc-horizon')) === state.calc.horizonMonths;
        b.className = active
          ? 'rounded-md bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white sf-transition whitespace-nowrap'
          : 'rounded-md px-3 py-1.5 text-xs font-medium text-slate-300 hover:text-white sf-transition whitespace-nowrap';
        b.setAttribute('aria-pressed', String(active));
      });
      renderCalculator();
    });
  });

  document.getElementById('calc-include-domain')?.addEventListener('change', (e) => {
    state.calc.includeDomain = Boolean(e.target.checked);
    renderCalculator();
  });

  // Price Mode Toggle (Intro vs Renewal)
  document.querySelectorAll('[data-price-mode]').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.priceMode = btn.getAttribute('data-price-mode') || 'intro';
      document.querySelectorAll('[data-price-mode]').forEach((b) => {
        const active = b.getAttribute('data-price-mode') === state.priceMode;
        b.className = active
          ? 'rounded-md bg-white px-3 py-1.5 text-xs font-semibold text-slate-900 shadow-xs sf-transition whitespace-nowrap'
          : 'rounded-md px-3 py-1.5 text-xs font-medium text-slate-600 hover:text-slate-900 sf-transition whitespace-nowrap';
        b.setAttribute('aria-pressed', String(active));
      });
      renderComparisonTable();
    });
  });

  document.getElementById('comparison-sort')?.addEventListener('change', (e) => {
    state.sortBy = e.target.value;
    renderComparisonTable();
  });

  // Filter Bar Inputs
  document.getElementById('filter-site-type')?.addEventListener('change', (e) => {
    state.filters.siteType = e.target.value;
    renderRecommendationResult();
    renderComparisonTable();
  });

  document.getElementById('filter-budget')?.addEventListener('change', (e) => {
    state.filters.budget = e.target.value;
    renderRecommendationResult();
    renderComparisonTable();
  });

  [
    ['freeDomain', 'freeDomain'],
    ['freeSsl', 'freeSsl'],
    ['freeMigration', 'freeMigration'],
    ['monthlyBilling', 'monthlyBilling'],
  ].forEach(([domKey, stateKey]) => {
    document.getElementById(`filter-${domKey}`)?.addEventListener('change', (e) => {
      state.filters[stateKey] = Boolean(e.target.checked);
      renderRecommendationResult();
      renderComparisonTable();
    });
  });

  document.getElementById('filter-reset-btn')?.addEventListener('click', resetAllFilters);
}

/* ---------- Coupons Directory Page ---------- */

function renderCouponsDirectory() {
  const grid = document.getElementById('coupons-directory-grid');
  const providerTabs = document.getElementById('coupon-provider-tabs');
  if (!grid || !state.data) return;

  if (providerTabs && !providerTabs.dataset.initialized) {
    providerTabs.dataset.initialized = 'true';
    const buttons = [
      { id: 'all', label: 'All Providers' },
      ...state.data.providers.map((p) => ({ id: p.id, label: p.name })),
    ];
    providerTabs.innerHTML = buttons
      .map(
        (b) => `
          <button
            type="button"
            data-coupon-provider="${escapeHtml(b.id)}"
            class="rounded-md px-3 py-1.5 text-xs font-medium sf-transition whitespace-nowrap ${
              state.couponFilter.provider === b.id
                ? 'bg-slate-900 text-white'
                : 'border border-slate-200 bg-white text-slate-700 hover:bg-slate-50'
            }"
          >
            ${escapeHtml(b.label)}
          </button>
        `
      )
      .join('');

    providerTabs.querySelectorAll('[data-coupon-provider]').forEach((btn) => {
      btn.addEventListener('click', () => {
        state.couponFilter.provider = btn.getAttribute('data-coupon-provider') || 'all';
        providerTabs.querySelectorAll('[data-coupon-provider]').forEach((b) => {
          const active = b.getAttribute('data-coupon-provider') === state.couponFilter.provider;
          b.className = active
            ? 'rounded-md px-3 py-1.5 text-xs font-medium sf-transition whitespace-nowrap bg-slate-900 text-white'
            : 'rounded-md px-3 py-1.5 text-xs font-medium sf-transition whitespace-nowrap border border-slate-200 bg-white text-slate-700 hover:bg-slate-50';
        });
        renderCouponsDirectory();
      });
    });

    document.querySelectorAll('[data-coupon-type]').forEach((btn) => {
      btn.addEventListener('click', () => {
        state.couponFilter.promoType = btn.getAttribute('data-coupon-type') || 'all';
        document.querySelectorAll('[data-coupon-type]').forEach((b) => {
          const active = b.getAttribute('data-coupon-type') === state.couponFilter.promoType;
          b.className = active
            ? 'rounded-md bg-white px-3 py-1.5 text-xs font-semibold text-slate-900 shadow-xs sf-transition whitespace-nowrap'
            : 'rounded-md px-3 py-1.5 text-xs font-medium text-slate-600 hover:text-slate-900 sf-transition whitespace-nowrap';
        });
        renderCouponsDirectory();
      });
    });
  }

  const filtered = state.data.providers.filter((p) => {
    if (state.couponFilter.provider !== 'all' && p.id !== state.couponFilter.provider) {
      return false;
    }
    if (state.couponFilter.promoType !== 'all' && p.promoType !== state.couponFilter.promoType) {
      return false;
    }
    return true;
  });

  if (filtered.length === 0) {
    grid.innerHTML = `
      <div class="col-span-full rounded-lg border border-slate-200 bg-white p-8 text-center">
        <p class="text-sm font-medium text-slate-900">No deals match the selected filter.</p>
        <p class="mt-1 text-xs text-slate-500">Most hosts apply introductory pricing automatically without manual promo codes.</p>
      </div>
    `;
    return;
  }

  const fallbackDate = formatDateReadable(state.data.lastUpdated);

  grid.innerHTML = filtered
    .map((p) => {
      const discountLabel =
        p.discountPercent > 0 ? `${p.discountPercent}% Off Intro Term` : 'Flat Monthly Rate';
      const verifiedDate = p.lastVerifiedAt ? formatDateReadable(p.lastVerifiedAt) : fallbackDate;
      const isExpired = String(p.status || '').toLowerCase() === 'expired';
      const statusClass = isExpired ? 'text-red-700 font-semibold' : 'text-emerald-700 font-medium';

      const stepsHtml = (p.redemptionSteps || [])
        .map((step, i) => `<li class="text-xs leading-relaxed text-slate-600"><span class="font-mono font-semibold text-slate-900">${i + 1}.</span> ${escapeHtml(step)}</li>`)
        .join('');

      const expiredHistory = Array.isArray(p.expiredCoupons) ? p.expiredCoupons : [];
      const expiredHtml =
        expiredHistory.length > 0
          ? `
            <div class="mt-3 rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600">
              <span class="font-medium text-slate-700">Previous expired code:</span>
              <span class="font-mono line-through text-slate-500">${escapeHtml(expiredHistory[0].code)}</span>
              <span aria-hidden="true">&middot;</span>
              <span>Expired ${escapeHtml(formatDateReadable(expiredHistory[0].expiredAt))}</span>
              ${
                expiredHistory[0].replacedBy
                  ? `<span> &rarr; Replaced with <strong class="font-mono text-slate-900">${escapeHtml(expiredHistory[0].replacedBy)}</strong></span>`
                  : '<span> &rarr; Switched to Auto-Applied Deal</span>'
              }
            </div>
          `
          : '';

      return `
        <article class="rounded-lg border border-slate-200 bg-white p-6 flex flex-col justify-between">
          <div>
            <div class="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 pb-3">
              <div class="flex items-center gap-2 text-xs text-slate-500">
                <span class="font-semibold text-slate-900">${escapeHtml(p.name)}</span>
                <span aria-hidden="true">&middot;</span>
                <span>${escapeHtml(p.promoBadgeText)}</span>
                <span aria-hidden="true">&middot;</span>
                <span class="${statusClass}">${escapeHtml(p.status)}</span>
              </div>
              <span class="font-mono text-xs text-slate-500 tabular-nums">Checked ${escapeHtml(verifiedDate)}</span>
            </div>

            <div class="mt-4 flex items-start justify-between gap-4">
              <div>
                <h2 class="text-lg font-bold text-slate-900">${escapeHtml(discountLabel)} &mdash; ${escapeHtml(p.planName)}</h2>
                <p class="mt-1 text-sm text-slate-700">${escapeHtml(p.promoHeadline)}</p>
              </div>
              <div class="text-right shrink-0">
                <div class="font-mono text-xl font-bold text-slate-900 tabular-nums">${formatCurrency(p.introPriceMonthly)}/mo</div>
                <div class="font-mono text-xs text-slate-500 tabular-nums">Renews ${formatCurrency(p.renewalPriceMonthly)}/mo</div>
              </div>
            </div>

            <p class="mt-3 text-xs text-slate-500">${escapeHtml(p.promoTerms)}</p>
            ${expiredHtml}

            <div class="mt-4 rounded-md border border-slate-100 bg-slate-50 p-3.5">
              <div class="text-xs font-semibold text-slate-900">How to redeem</div>
              <ol class="mt-2 space-y-1.5">${stepsHtml}</ol>
            </div>
          </div>

          <div class="mt-5 flex flex-wrap items-center justify-between gap-3 border-t border-slate-100 pt-4">
            ${renderPromoActionHtml(p)}
            <a href="/contact.html?report=${encodeURIComponent(p.name)}" class="text-xs text-slate-500 hover:text-slate-900 underline underline-offset-2">
              Report expired offer
            </a>
          </div>
        </article>
      `;
    })
    .join('');

  bindDynamicActionButtons(grid);
}

/* ---------- Hostinger vs Bluehost Head-to-Head Hydration ---------- */

function initVsPage() {
  const container = document.getElementById('vs-live-tco');
  if (!container || !state.data) return;

  const hostinger = state.data.providers.find((p) => p.id === 'hostinger');
  const bluehost = state.data.providers.find((p) => p.id === 'bluehost');
  if (!hostinger || !bluehost) return;

  const avgDom = state.data.averageDomainRenewalYearly || 18.99;

  const renderVsTco = (months) => {
    const h = computePlanTCO(hostinger, months, true, avgDom);
    const b = computePlanTCO(bluehost, months, true, avgDom);
    const diff = Math.abs(b.totalCost - h.totalCost);
    const cheaper = h.totalCost <= b.totalCost ? 'Hostinger' : 'Bluehost';

    container.innerHTML = `
      <div class="grid gap-4 sm:grid-cols-2">
        <div class="rounded-lg border border-indigo-200 bg-white p-5">
          <div class="flex items-center justify-between">
            <h3 class="text-base font-bold text-slate-900">Hostinger (${escapeHtml(hostinger.planName)})</h3>
            <span class="font-mono text-lg font-bold text-slate-900 tabular-nums">${formatCurrency(h.totalCost)}</span>
          </div>
          <p class="mt-1 text-xs text-slate-500">
            ${formatCurrency(hostinger.introPriceMonthly)}/mo intro (${hostinger.billingTermMonths}-mo term) &middot; Renews at ${formatCurrency(hostinger.renewalPriceMonthly)}/mo
          </p>
          <div class="mt-3 flex justify-between border-t border-slate-100 pt-3 text-xs">
            <span class="text-slate-600">Blended monthly over ${months} mo</span>
            <span class="font-mono font-semibold text-slate-900 tabular-nums">${formatCurrency(h.effectiveMonthly)}/mo</span>
          </div>
        </div>

        <div class="rounded-lg border border-slate-200 bg-white p-5">
          <div class="flex items-center justify-between">
            <h3 class="text-base font-bold text-slate-900">Bluehost (${escapeHtml(bluehost.planName)})</h3>
            <span class="font-mono text-lg font-bold text-slate-900 tabular-nums">${formatCurrency(b.totalCost)}</span>
          </div>
          <p class="mt-1 text-xs text-slate-500">
            ${formatCurrency(bluehost.introPriceMonthly)}/mo intro (${bluehost.billingTermMonths}-mo term) &middot; Renews at ${formatCurrency(bluehost.renewalPriceMonthly)}/mo
          </p>
          <div class="mt-3 flex justify-between border-t border-slate-100 pt-3 text-xs">
            <span class="text-slate-600">Blended monthly over ${months} mo</span>
            <span class="font-mono font-semibold text-slate-900 tabular-nums">${formatCurrency(b.effectiveMonthly)}/mo</span>
          </div>
        </div>
      </div>
      <p class="mt-3 text-xs font-medium text-emerald-700">
        Over a ${months}-month horizon (including estimated $18.99/yr domain renewal after Year 1), ${cheaper} saves ${formatCurrency(diff)}.
      </p>
    `;
  };

  renderVsTco(36);
  document.querySelectorAll('[data-vs-horizon]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const m = Number(btn.getAttribute('data-vs-horizon')) || 36;
      document.querySelectorAll('[data-vs-horizon]').forEach((b) => {
        const active = Number(b.getAttribute('data-vs-horizon')) === m;
        b.className = active
          ? 'rounded-md bg-slate-900 px-3 py-1.5 text-xs font-medium text-white sf-transition whitespace-nowrap'
          : 'rounded-md border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 sf-transition whitespace-nowrap';
      });
      renderVsTco(m);
    });
  });
}

/* ---------- Contact Form Controller ---------- */

function initContactForm() {
  const form = document.getElementById('sf-contact-form');
  if (!form) return;

  const topicSelect = document.getElementById('contact-topic');
  const providerWrapper = document.getElementById('contact-provider-wrap');
  const providerInput = document.getElementById('contact-provider');
  const statusEl = document.getElementById('contact-form-status');

  const params = new URLSearchParams(window.location.search);
  const reportProvider = params.get('report');
  if (reportProvider && topicSelect) {
    topicSelect.value = 'expired-coupon';
    if (providerWrapper) providerWrapper.classList.remove('hidden');
    if (providerInput) providerInput.value = reportProvider;
  }

  topicSelect?.addEventListener('change', (e) => {
    if (!providerWrapper) return;
    providerWrapper.classList.toggle('hidden', e.target.value !== 'expired-coupon');
  });

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const name = document.getElementById('contact-name')?.value.trim() || '';
    const email = document.getElementById('contact-email')?.value.trim() || '';
    const topic = topicSelect?.value || 'general';
    const message = document.getElementById('contact-message')?.value.trim() || '';

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!name || !emailRegex.test(email) || message.length < 10) {
      if (statusEl) {
        statusEl.className = 'mt-4 rounded-md border border-red-200 bg-red-50 p-3 text-xs text-red-800';
        statusEl.textContent = 'Please provide your name, a valid email address, and at least 10 characters in your message.';
      }
      return;
    }

    const subject = encodeURIComponent(`[SkyeFlare] ${topic === 'expired-coupon' ? 'Expired Coupon / Price Report' : 'Inquiry'} from ${name}`);
    const body = encodeURIComponent(
      `Name: ${name}\nEmail: ${email}\nTopic: ${topic}\nProvider: ${providerInput?.value || 'N/A'}\n\nMessage:\n${message}`
    );

    if (statusEl) {
      statusEl.className = 'mt-4 rounded-md border border-emerald-200 bg-emerald-50 p-4 text-xs text-emerald-900';
      statusEl.innerHTML = `
        <div class="font-semibold">Message validated and ready to send.</div>
        <p class="mt-1">
          Because SkyeFlare runs as a static privacy-first site, click below to dispatch directly via your email client to
          <a href="mailto:contact@skyeflare.com?subject=${subject}&body=${body}" class="font-semibold underline">contact@skyeflare.com</a>.
        </p>
      `;
    }
    showToast('Submission prepared — click the email link to send.');
  });
}

/* ---------- Dynamic Event Delegation ---------- */

function bindDynamicActionButtons(root) {
  root.querySelectorAll('[data-copy-code]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const code = btn.getAttribute('data-copy-code');
      const providerName = btn.getAttribute('data-provider-name') || 'Provider';
      if (code) copyPromoCode(code, providerName);
    });
  });

  root.querySelectorAll('[data-load-calculator]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const pid = btn.getAttribute('data-load-calculator');
      if (!pid) return;
      state.calc.providerId = pid;
      state.calc.planIndex = 0;
      const select = document.getElementById('calc-provider');
      if (select) select.value = pid;
      renderCalculator();
      document.getElementById('cost-calculator')?.scrollIntoView({ behavior: 'smooth' });
    });
  });
}

/* ---------- Boot ---------- */

async function bootstrap() {
  initMobileNav();
  initCookieConsent();
  initContactForm();

  const needsData = Boolean(
    document.getElementById('comparison-table-body') ||
      document.getElementById('coupons-directory-grid') ||
      document.getElementById('vs-live-tco') ||
      document.querySelector('[data-last-updated]')
  );

  if (!needsData) return;

  try {
    state.data = await loadDealsData();
    hydrateLastUpdatedLabels(state.data.lastUpdated);

    if (document.getElementById('comparison-table-body')) {
      initHomeControls();
      renderRecommendationResult();
      renderComparisonTable();
      renderCalculator();
    }

    if (document.getElementById('coupons-directory-grid')) {
      renderCouponsDirectory();
    }

    if (document.getElementById('vs-live-tco')) {
      initVsPage();
    }
  } catch (err) {
    const errorBox = `
      <div class="rounded-lg border border-red-200 bg-red-50 p-6 text-center">
        <p class="text-sm font-semibold text-red-900">Unable to load hosting deal registry</p>
        <p class="mt-1 text-xs text-red-700">${escapeHtml(err.message)}</p>
        <button type="button" onclick="window.location.reload()" class="mt-3 rounded-md bg-red-800 px-3 py-1.5 text-xs font-medium text-white hover:bg-red-900">
          Retry
        </button>
      </div>
    `;
    const tbody = document.getElementById('comparison-table-body');
    const coupons = document.getElementById('coupons-directory-grid');
    if (tbody) tbody.innerHTML = `<tr><td colspan="7" class="p-4">${errorBox}</td></tr>`;
    if (coupons) coupons.innerHTML = `<div class="col-span-full">${errorBox}</div>`;
  }
}

document.addEventListener('DOMContentLoaded', bootstrap);
