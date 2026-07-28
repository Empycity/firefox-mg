// Firefox Trace runtime profile template.
//
// Copy this file to <profile>/user.js before launching the modified Firefox.
// These prefs are intentionally about browser background noise only: updates,
// telemetry, recommendations, remote experiments, captive-portal checks,
// newtab/content feeds, and default-browser prompts. Browser-visible automation
// and fingerprint surfaces are handled by explicit trace surface modes instead
// of being mixed into this background-noise profile.

// Keep startup deterministic and avoid about:home/about:newtab background work.
user_pref("browser.startup.page", 0);
user_pref("browser.startup.homepage", "about:blank");
user_pref("browser.shell.checkDefaultBrowser", false);
user_pref("browser.aboutwelcome.enabled", false);
user_pref("startup.homepage_welcome_url", "");
user_pref("startup.homepage_welcome_url.additional", "");
user_pref("browser.tabs.warnOnClose", false);
user_pref("browser.sessionstore.resume_from_crash", false);
user_pref("browser.sessionstore.max_tabs_undo", 0);
user_pref("browser.sessionstore.max_windows_undo", 0);

// Disable telemetry/data reporting/background experiments.
user_pref("datareporting.policy.dataSubmissionEnabled", false);
user_pref("datareporting.healthreport.uploadEnabled", false);
user_pref("toolkit.telemetry.enabled", false);
user_pref("toolkit.telemetry.unified", false);
user_pref("toolkit.telemetry.archive.enabled", false);
user_pref("toolkit.telemetry.updatePing.enabled", false);
user_pref("toolkit.telemetry.bhrPing.enabled", false);
user_pref("toolkit.telemetry.firstShutdownPing.enabled", false);
user_pref("toolkit.telemetry.newProfilePing.enabled", false);
user_pref("toolkit.telemetry.shutdownPingSender.enabled", false);
user_pref("toolkit.telemetry.reportingpolicy.firstRun", false);
user_pref("app.normandy.enabled", false);
user_pref("app.normandy.api_url", "");
user_pref("app.shield.optoutstudies.enabled", false);
user_pref("nimbus.remote-settings.enabled", false);
user_pref("messaging-system.rsexperimentloader.enabled", false);

// Disable update/addon/search recommendation background fetches.
user_pref("app.update.enabled", false);
user_pref("app.update.auto", false);
user_pref("extensions.update.enabled", false);
user_pref("extensions.getAddons.cache.enabled", false);
user_pref("extensions.systemAddon.update.enabled", false);
user_pref("browser.search.update", false);
user_pref("browser.region.update.enabled", false);
user_pref("browser.region.network.url", "");
user_pref("browser.region.update.regionFetchTimeout", 1);
user_pref("services.settings.loglevel", "off");
user_pref("services.settings.poll_interval", 31536000);

// Disable newtab/content recommendation services.
user_pref("browser.newtabpage.enabled", false);
user_pref("browser.newtabpage.activity-stream.feeds.topsites", false);
user_pref("browser.newtabpage.activity-stream.feeds.section.topstories", false);
user_pref("browser.newtabpage.activity-stream.feeds.system.topstories", false);
user_pref("browser.newtabpage.activity-stream.discoverystream.enabled", false);
user_pref("browser.newtabpage.activity-stream.showSponsored", false);
user_pref("browser.newtabpage.activity-stream.showSponsoredTopSites", false);
user_pref("browser.newtabpage.activity-stream.telemetry", false);
user_pref("browser.newtabpage.activity-stream.telemetry.structuredIngestion", false);
user_pref("browser.urlbar.quicksuggest.enabled", false);
user_pref("browser.urlbar.suggest.quicksuggest.nonsponsored", false);
user_pref("browser.urlbar.suggest.quicksuggest.sponsored", false);
user_pref("browser.ping-centre.telemetry", false);

// Disable network probes unrelated to the target page.
user_pref("network.captive-portal-service.enabled", false);
user_pref("captivedetect.canonicalURL", "");
user_pref("network.connectivity-service.enabled", false);
user_pref("network.predictor.enabled", false);
user_pref("network.prefetch-next", false);
user_pref("network.dns.disablePrefetch", true);
user_pref("network.http.speculative-parallel-limit", 0);
user_pref("dom.push.enabled", false);
user_pref("dom.push.connection.enabled", false);

// Keep script loading deterministic for trace runs. Bytecode/navigation cache
// can make page transitions depend on stale per-profile script state, which is
// bad for reproducible trace and has caused fragile ScriptLoadHandler paths on
// heavy navigation pages.
user_pref("dom.script_loader.bytecode_cache.enabled", false);
user_pref("dom.script_loader.bytecode_cache.strategy", -2);
user_pref("dom.script_loader.navigation_cache", false);

// Avoid sign-in/sync and other browser chrome services during trace runs.
user_pref("identity.fxaccounts.enabled", false);
user_pref("services.sync.engine.addons", false);
user_pref("services.sync.engine.addresses", false);
user_pref("services.sync.engine.bookmarks", false);
user_pref("services.sync.engine.creditcards", false);
user_pref("services.sync.engine.history", false);
user_pref("services.sync.engine.passwords", false);
user_pref("services.sync.engine.prefs", false);
user_pref("services.sync.engine.tabs", false);

// Keep the target page's normal web security model. Do not disable CSP, CORS,
// storage partitioning, cookies, WebGL, canvas, WebCrypto, or site isolation here.
