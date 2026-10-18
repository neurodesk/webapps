/*! coi-serviceworker v0.1.7 - Guido Zuidhof and contributors, licensed under MIT */
let coepCredentialless = false;
const coiRuntimeConfig = /*__COI_RUNTIME_CONFIG__*/ {};
if (typeof window === 'undefined') {
    self.addEventListener("install", () => self.skipWaiting());
    const runtimeCacheEnabled = coiRuntimeConfig.runtimeCache === true;
    const runtimeCacheName = "neurodesk-runtime-assets-v1";
    const clientCacheName = "neurodesk-runtime-clients-v1";
    const clientReferences = new Map();
    const manifestLoads = new Map();
    const runtimeDownloads = new Map();
    self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

    function manifestReference(value, base = self.location.href) {
        try {
            if (typeof value !== "string") return;
            const url = new URL(value, base);
            if (url.search || url.hash || new URL("./", url).href !== new URL("./", self.location.href).href) return;
            if (!/\/runtime-cache-manifest\.[a-f0-9]{64}\.json$/.test(url.pathname)) return;
            return url.href;
        } catch {
            return undefined;
        }
    }

    async function sha256(body) {
        const hash = await crypto.subtle.digest("SHA-256", body);
        return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, "0")).join("");
    }

    function parseRuntimeManifest(body) {
        const manifest = JSON.parse(new TextDecoder().decode(body));
        if (manifest.schema_version !== 1 || !Array.isArray(manifest.assets)) throw new Error("Invalid runtime manifest");
        const assets = new Map();
        for (const asset of manifest.assets) {
            const url = new URL(asset.url, self.location.href);
            const contentType = url.pathname.toLowerCase().endsWith(".wasm")
                ? "application/wasm"
                : "application/octet-stream";
            if (typeof asset.url !== "string" || url.origin !== self.location.origin
                || url.username || url.password || url.search || url.hash
                || !/\.(?:wasm|onnx|data|bin)$/i.test(url.pathname)
                || !/^[a-f0-9]{64}$/.test(asset.sha256)
                || !Number.isSafeInteger(asset.bytes) || asset.bytes < 0
                || asset.contentType !== contentType || assets.has(url.href)) throw new Error("Invalid runtime manifest asset");
            assets.set(url.href, asset);
        }
        return assets;
    }

    async function readManifestBody(response, expectedHash) {
        if (response.status !== 200 || response.type === "opaque") throw new Error(`HTTP ${response.status}`);
        const body = await response.arrayBuffer();
        if (await sha256(body) !== expectedHash) throw new Error("Runtime manifest integrity check failed");
        return body;
    }

    function loadRuntimeManifest(reference) {
        if (!manifestLoads.has(reference)) {
            const load = (async () => {
                const expectedHash = new URL(reference).pathname.match(/\.([a-f0-9]{64})\.json$/)[1];
                const cache = await runtimeCache("neurodesk-runtime-manifests-v1");
                if (cache) {
                    try {
                        const cached = await cache.match(reference);
                        if (cached) {
                            try {
                                return parseRuntimeManifest(await readManifestBody(cached, expectedHash));
                            } catch {
                                await cache.delete(reference);
                            }
                        }
                    } catch (error) {
                        console.warn("Runtime manifest cache read failed:", error);
                    }
                }
                const response = await fetch(reference, { cache: "no-store", credentials: "same-origin" });
                const body = await readManifestBody(response, expectedHash);
                const assets = parseRuntimeManifest(body);
                if (cache) {
                    try {
                        await cache.put(reference, new Response(body, { headers: { "Content-Type": "application/json" } }));
                    } catch (error) {
                        console.warn("Runtime manifest cache write failed:", error);
                    }
                }
                return assets;
            })().catch(error => {
                manifestLoads.delete(reference);
                console.warn("Runtime cache manifest load failed:", error);
                return new Map();
            });
            manifestLoads.set(reference, load);
        }
        return manifestLoads.get(reference);
    }

    function clientIdentityKey(clientId) {
        return new URL(`/.neurodesk-runtime-clients/${encodeURIComponent(clientId)}`, self.location.origin).href;
    }

    async function bindClientReference(clientId, reference) {
        if (!clientId) return;
        if (reference) clientReferences.set(clientId, reference);
        else clientReferences.delete(clientId);
        try {
            const cache = await caches.open(clientCacheName);
            if (reference) await cache.put(clientIdentityKey(clientId), new Response(reference));
            else await cache.delete(clientIdentityKey(clientId));
        } catch (error) {
            console.warn("Runtime client identity cache write failed:", error);
        }
    }

    async function referenceForClient(clientId) {
        if (!clientId) return;
        if (clientReferences.has(clientId)) return clientReferences.get(clientId);
        try {
            const cache = await caches.open(clientCacheName);
            const saved = await cache.match(clientIdentityKey(clientId));
            const reference = saved && manifestReference(await saved.text());
            if (reference) {
                clientReferences.set(clientId, reference);
                return reference;
            }
        } catch (error) {
            console.warn("Runtime client identity cache read failed:", error);
        }
        const client = await self.clients.get(clientId);
        if (client?.type !== "window") return;
        const reference = await new Promise(resolve => {
            const channel = new MessageChannel();
            const timer = setTimeout(() => { channel.port1.close(); resolve(); }, 500);
            channel.port1.onmessage = (event) => {
                clearTimeout(timer);
                channel.port1.close();
                resolve(manifestReference(event.data));
            };
            client.postMessage({ type: "runtimeManifestRequest" }, [channel.port2]);
        });
        if (reference) await bindClientReference(clientId, reference);
        return reference;
    }

    async function runtimeCache(name = runtimeCacheName) {
        try {
            return await caches.open(name);
        } catch (error) {
            console.warn("Runtime cache is unavailable:", error);
            return undefined;
        }
    }

    async function verifiedBody(response, asset) {
        if (response.status !== 200 || response.type === "opaque" || response.headers.has("Content-Range")) return;
        const body = await response.arrayBuffer();
        if (body.byteLength !== asset.bytes) return;
        if (await sha256(body) === asset.sha256) return body;
    }

    function runtimeResponse(body, response, asset) {
        const headers = new Headers(response.headers);
        headers.set("Content-Type", asset.contentType);
        headers.set("Content-Length", String(asset.bytes));
        headers.delete("Content-Encoding");
        return new Response(body, { status: 200, headers });
    }

    async function fetchRuntime(request, asset) {
        const cache = await runtimeCache();
        const key = new URL(`/.neurodesk-runtime-cache/${asset.sha256}`, self.location.origin).href;
        if (cache) {
            try {
                const cached = await cache.match(key);
                if (cached) {
                    const body = await verifiedBody(cached, asset);
                    if (body) return runtimeResponse(body, cached, asset);
                    await cache.delete(key);
                }
            } catch (error) {
                console.warn("Runtime cache read failed:", error);
            }
        }
        const response = await fetch(request, { cache: "reload" });
        if (response.status !== 200 || response.type === "opaque" || response.headers.has("Content-Range")) return response;
        const body = await verifiedBody(response, asset);
        if (!body) throw new Error(`Runtime integrity check failed for ${request.url}`);
        const verified = runtimeResponse(body, response, asset);
        if (cache) {
            try {
                await cache.put(key, verified.clone());
            } catch (error) {
                console.warn("Runtime cache write failed:", error);
            }
        }
        return verified;
    }

    async function respondToRequest(request, event) {
        if (request.mode === "navigate") {
            const response = await fetch(request);
            if (runtimeCacheEnabled && response.status === 200) {
                const html = await response.clone().text();
                const marker = html.match(/<meta\s+name="neurodesk-runtime-manifest"\s+content="([^"]+)"\s*>/i)?.[1];
                const reference = manifestReference(marker, response.url || request.url);
                await bindClientReference(event.resultingClientId, reference);
                if (reference) await loadRuntimeManifest(reference);
            }
            return response;
        }
        if (runtimeCacheEnabled && request.method === "GET") {
            const isBinary = /\.(?:wasm|onnx|data|bin)$/i.test(new URL(request.url).pathname);
            if (!isBinary && !event.resultingClientId) return fetch(request);
            const reference = await referenceForClient(event.clientId);
            if (event.resultingClientId && reference) await bindClientReference(event.resultingClientId, reference);
            if (isBinary && reference && !request.headers.has("Range")) {
                const asset = (await loadRuntimeManifest(reference)).get(request.url);
                if (asset) {
                    const downloadKey = `${request.url}:${asset.sha256}`;
                    let download = runtimeDownloads.get(downloadKey);
                    if (!download) {
                        download = fetchRuntime(request, asset).finally(() => runtimeDownloads.delete(downloadKey));
                        runtimeDownloads.set(downloadKey, download);
                    }
                    return (await download).clone();
                }
            }
        }
        return fetch(request);
    }

    self.addEventListener("message", (ev) => {
        if (!ev.data) {
            return;
        } else if (ev.data.type === "deregister") {
            self.registration
                .unregister()
                .then(() => self.clients.matchAll())
                .then(clients => clients.forEach((client) => client.navigate(client.url)));
        } else if (ev.data.type === "runtimeManifest" && runtimeCacheEnabled) {
            const reference = manifestReference(ev.data.url);
            if (reference && ev.source?.id) ev.waitUntil(bindClientReference(ev.source.id, reference));
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
            respondToRequest(isolatedRequest, event)
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
    // Resolves once this page knows whether it is about to reload, so work that must happen
    // only once per visit (taking a handoff) waits for the page that stays. That work then
    // calls coiHoldReloads, so a worker update cannot reload the page under it.
    let settleReload;
    let reloadsHeld = false;
    window.coiWillReload = new Promise((resolve) => { settleReload = resolve; });
    window.coiHoldReloads = () => { reloadsHeld = true; };
    (() => {
        try {
            const reloadedBySelf = window.sessionStorage.getItem("coiReloadedBySelf");
            window.sessionStorage.removeItem("coiReloadedBySelf");
            const coepDegrading = reloadedBySelf === "coepdegrade";
            const coi = {
                // A first-install update can reload before clients.claim() gives
                // the new page a controller. Do not let the one-shot reload marker
                // suppress the recovery registration in that state.
                shouldRegister: () => !reloadedBySelf || !navigator.serviceWorker?.controller,
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
                    settleReload(true);
                }
                if (coi.shouldDeregister()) navigatorApi.serviceWorker.controller.postMessage({ type: "deregister" });
            }

            const requiresRuntimeCache = coiRuntimeConfig.runtimeCache === true;
            const requiresWorkerFeatures = coiRuntimeConfig.alwaysRegister === true || requiresRuntimeCache;
            const documentManifest = () => window.document.querySelector?.('meta[name="neurodesk-runtime-manifest"]')?.content;
            const postManifestIdentity = () => {
                const url = documentManifest();
                if (url) navigatorApi.serviceWorker?.controller?.postMessage({ type: "runtimeManifest", url });
            };
            if (requiresRuntimeCache) {
                navigatorApi.serviceWorker?.addEventListener?.("controllerchange", postManifestIdentity);
                navigatorApi.serviceWorker?.addEventListener?.("message", (event) => {
                    if (event.data?.type === "runtimeManifestRequest") event.ports[0]?.postMessage(documentManifest());
                });
                postManifestIdentity();
            }
            const persistenceKey = Symbol.for("neurodesk.storage.persistenceRequested");
            if (requiresRuntimeCache && navigatorApi.storage?.persist && !globalThis[persistenceKey]) {
                globalThis[persistenceKey] = true;
                try {
                    Promise.resolve(navigatorApi.storage.persist()).catch(error => console.warn("Persistent storage request failed:", error));
                } catch (error) {
                    console.warn("Persistent storage request failed:", error);
                }
            }
            if ((!requiresWorkerFeatures && window.crossOriginIsolated !== false) || !coi.shouldRegister()) return settleReload(false);
            if (!window.isSecureContext) {
                !coi.quiet && console.log("COOP/COEP Service Worker not registered, a secure context is required.");
                return settleReload(false);
            }
            if (!navigatorApi.serviceWorker) {
                !coi.quiet && console.error("COOP/COEP Service Worker not registered, perhaps due to private mode.");
                return settleReload(false);
            }

            navigatorApi.serviceWorker.register(window.document.currentScript.src).then(
                (registration) => {
                    !coi.quiet && console.log("COOP/COEP Service Worker registered", registration.scope);
                    let reloadRequested = false;
                    const reloadOnce = (reason) => {
                        if (reloadRequested || reloadsHeld || window.crossOriginIsolated === true) return settleReload(false);
                        reloadRequested = true;
                        !coi.quiet && console.log("Reloading page to make use of updated COOP/COEP Service Worker.");
                        // Settle only once the reload is under way: a failed marker write means no reload.
                        try {
                            window.sessionStorage.setItem("coiReloadedBySelf", reason);
                            coi.doReload();
                            settleReload(true);
                        } catch (error) {
                            settleReload(false);
                            console.error("COOP/COEP Service Worker reload failed:", error);
                        }
                    };
                    const reloadWhenActive = (worker, reason) => {
                        if (!worker) {
                            navigatorApi.serviceWorker.ready.then(() => reloadOnce(reason));
                            return;
                        }
                        if (worker.state === "activated") {
                            reloadOnce(reason);
                            return;
                        }
                        worker.addEventListener("statechange", () => {
                            if (worker.state === "activated") reloadOnce(reason);
                            if (worker.state === "redundant") settleReload(false);
                        });
                    };
                    registration.addEventListener("updatefound", () => {
                        reloadWhenActive(registration.installing, "updatefound");
                    });
                    if (!navigatorApi.serviceWorker.controller) {
                        // register() may resolve after updatefound has already fired.
                        // Observe the worker returned by the registration as well so
                        // a clean first visit cannot remain unisolated indefinitely.
                        const worker = registration.installing || registration.waiting || registration.active;
                        reloadWhenActive(worker, "notcontrolling");
                    } else {
                        settleReload(false);
                    }
                },
                (error) => {
                    settleReload(false);
                    !coi.quiet && console.error("COOP/COEP Service Worker failed to register:", error);
                }
            ).catch((error) => {
                settleReload(false);
                console.error("COOP/COEP Service Worker bootstrap failed:", error);
            });
        } catch (error) {
            settleReload(false);
            console.error("COOP/COEP Service Worker bootstrap failed:", error);
        }
    })();
}
