/*! coi-serviceworker v0.1.7 - Guido Zuidhof and contributors, licensed under MIT */
let coepCredentialless = false;
const coiRuntimeConfig = /*__COI_RUNTIME_CONFIG__*/ {};
if (typeof window === 'undefined') {
    self.addEventListener("install", () => self.skipWaiting());
    self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

    self.addEventListener("message", (ev) => {
        if (!ev.data) {
            return;
        } else if (ev.data.type === "deregister") {
            self.registration
                .unregister()
                .then(() => self.clients.matchAll())
                .then(clients => clients.forEach((client) => client.navigate(client.url)));
        } else if (ev.data.type === "coepCredentialless") {
            coepCredentialless = ev.data.value;
        }
    });

    self.addEventListener("fetch", function (event) {
        const request = event.request;
        if (request.cache === "only-if-cached" && request.mode !== "same-origin") return;

        const isCacheRoute = coiRuntimeConfig.cacheRoute
            && new URL(request.url).pathname.includes(coiRuntimeConfig.cacheRoute);
        if (isCacheRoute) {
            if (request.method !== "GET") {
                event.respondWith(fetch(request));
                return;
            }
            event.respondWith(
                caches.open(coiRuntimeConfig.cacheName)
                    .then((cache) => cache.match(request.url))
                    .then((response) => {
                        if (!response) return fetch(request);
                        return withIsolationHeaders(response);
                    })
            );
            return;
        }

        const isolatedRequest = (coepCredentialless && request.mode === "no-cors")
            ? new Request(request, { credentials: "omit" })
            : request;
        event.respondWith(
            fetch(isolatedRequest)
                .then((response) => {
                    if (response.status === 0) return response;
                    return withIsolationHeaders(response);
                })
                .catch((error) => {
                    console.warn("COOP/COEP Service Worker fetch failed:", error);
                    return Response.error();
                })
        );
    });

    function withIsolationHeaders(response) {
        const headers = new Headers(response.headers);
        headers.set("Cross-Origin-Embedder-Policy", coepCredentialless ? "credentialless" : "require-corp");
        if (!coepCredentialless) headers.set("Cross-Origin-Resource-Policy", "cross-origin");
        headers.set("Cross-Origin-Opener-Policy", "same-origin");
        const nullBodyStatus = response.status === 204 || response.status === 205 || response.status === 304;
        return new Response(nullBodyStatus ? null : response.body, {
            status: response.status,
            statusText: response.statusText,
            headers,
        });
    }
} else {
    (() => {
        const reloadedBySelf = window.sessionStorage.getItem("coiReloadedBySelf");
        window.sessionStorage.removeItem("coiReloadedBySelf");
        const coepDegrading = reloadedBySelf === "coepdegrade";
        const coi = {
            shouldRegister: () => !reloadedBySelf,
            shouldDeregister: () => false,
            coepCredentialless: () => true,
            coepDegrade: () => true,
            doReload: () => window.location.reload(),
            quiet: false,
            ...window.coi
        };
        const navigatorApi = navigator;
        const controlling = navigatorApi.serviceWorker && navigatorApi.serviceWorker.controller;

        if (controlling && !window.crossOriginIsolated) {
            window.sessionStorage.setItem("coiCoepHasFailed", "true");
        }
        const coepHasFailed = window.sessionStorage.getItem("coiCoepHasFailed");
        if (controlling) {
            const reloadToDegrade = coi.coepDegrade() && !(coepDegrading || window.crossOriginIsolated);
            navigatorApi.serviceWorker.controller.postMessage({
                type: "coepCredentialless",
                value: (reloadToDegrade || coepHasFailed && coi.coepDegrade())
                    ? false
                    : coi.coepCredentialless(),
            });
            if (reloadToDegrade) {
                !coi.quiet && console.log("Reloading page to degrade COEP.");
                window.sessionStorage.setItem("coiReloadedBySelf", "coepdegrade");
                coi.doReload("coepdegrade");
            }
            if (coi.shouldDeregister()) navigatorApi.serviceWorker.controller.postMessage({ type: "deregister" });
        }

        const requiresWorkerFeatures = coiRuntimeConfig.alwaysRegister === true;
        if ((!requiresWorkerFeatures && window.crossOriginIsolated !== false) || !coi.shouldRegister()) return;
        if (!window.isSecureContext) {
            !coi.quiet && console.log("COOP/COEP Service Worker not registered, a secure context is required.");
            return;
        }
        if (!navigatorApi.serviceWorker) {
            !coi.quiet && console.error("COOP/COEP Service Worker not registered, perhaps due to private mode.");
            return;
        }

        navigatorApi.serviceWorker.register(window.document.currentScript.src).then(
            (registration) => {
                !coi.quiet && console.log("COOP/COEP Service Worker registered", registration.scope);
                registration.addEventListener("updatefound", () => {
                    !coi.quiet && console.log("Reloading page to make use of updated COOP/COEP Service Worker.");
                    window.sessionStorage.setItem("coiReloadedBySelf", "updatefound");
                    coi.doReload();
                });
                if (registration.active && !navigatorApi.serviceWorker.controller) {
                    !coi.quiet && console.log("Reloading page to make use of updated COOP/COEP Service Worker.");
                    window.sessionStorage.setItem("coiReloadedBySelf", "notcontrolling");
                    coi.doReload();
                }
            },
            (error) => !coi.quiet && console.error("COOP/COEP Service Worker failed to register:", error)
        );
    })();
}
