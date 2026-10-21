/* eslint-disable no-empty */

// !    __    ____  ____
// !   /__\  (  _ \(_  _)
// !  /(__)\  )___/ _)(_
// ! (__)(__)(__)  (____)
// !

let mountedApiLeadzy = {};

function mountLeadzyApi() {
  if (window.apiLeadzy) {
    // console.error("API already mounted. Returning the same instance.");
    return;
  }

  let loaderType = "unknown";
  let isInjected = false;
  // eslint-disable-next-line no-unused-vars
  let isReady = false;
  // eslint-disable-next-line no-unused-vars
  let isFullReady = false;

  const __debug = () => (self || window).require("__debug");

  // console.log("Version => ", self.Debug.VERSION);

  let webpackRequire;

  const fallbackModules = {};

  function injectLoader() {
    if (isInjected) return;
    const global = self || window;

    /* BEGIN: For WhatsApp >= 2.3000.0 */
    const metaTimer = setInterval(async () => {
      if (loaderType !== "unknown") {
        clearInterval(metaTimer);
        return;
      }
      if (!global.require || !global.__d) {
        return;
      }
      loaderType = "meta";

      // A wrap to work like webpack
      webpackRequire = function (id) {
        try {
          global.ErrorGuard.skipGuardGlobal(true);
          return global.importNamespace(id);
        } catch (error) {}
        return null;
      };

      Object.defineProperty(webpackRequire, "m", {
        get: () => {
          const modulesMap = __debug().modulesMap;
          const ids = Object.keys(modulesMap).filter(
            (id) =>
              /^(?:use)?WA/.test(id) &&
              // Fix for error "bx(...): Unknown file path "9550""
              id !== "WAWebEmojiPanelContentEmojiSearchEmpty.react",
          );
          const result = {};

          for (const id of ids) {
            result[id] = modulesMap[id]?.factory;
          }

          return result;
        },
      });

      isInjected = true;

      // debug("injected");

      await new Promise((resolve) => setTimeout(resolve, 1000));

      isReady = true;

      window.apiLeadzy = await assembleAPI();
      window.wppForceMainLoad && (await new Promise((l) => setTimeout(l, 5e3))); // falta ver o que faz
    }, 1000);
    /* END: For WhatsApp >= 2.3000.0 */

    const chunkName = "webpackChunkwhatsapp_web_client";
    const chunk = global[chunkName] || [];

    const version = self.Debug.VERSION || "2.9000.0";

    if (compare(version, "2.3000.0", ">=")) {
      Object.defineProperty(global, chunkName, chunk);
    } else {
      loaderType = "webpack";
    }

    const injectFunction = async (__webpack_require__) => {
      loaderType = "webpack";
      webpackRequire = __webpack_require__;

      isInjected = true;
      await new Promise((d) => setTimeout(d, 500));

      const allRuntimes = new Array(10000)
        .fill(1)
        .map((v, k) => v + k)
        .filter((v) => {
          const filename = webpackRequire.u(v);
          if (filename.includes("locales")) {
            return navigator.languages.some((lang) =>
              filename.includes(`locales/${lang}`),
            );
          }
          return !filename.includes("undefined");
        });

      const mainRuntimes = allRuntimes.filter((v) => {
        const filename = webpackRequire.u(v);
        return filename.includes("main") && !filename.includes("locales");
      });

      // Use sequential file load
      for (const v of mainRuntimes) {
        try {
          await webpackRequire.e(v);
        } catch (error) {}
      }

      isReady = true;

      window.apiLeadzy = await assembleAPI();

      if (window.wppForceMainLoad) {
        await new Promise((resolve) => setTimeout(resolve, 5000));
      } else {
        // await waitMainReady;
      }

      // Use sequential file load
      for (const v of allRuntimes) {
        try {
          await webpackRequire.e(v);
        } catch (error) {
          // debug('load file error', webpackRequire.u(v));
        }
      }

      isFullReady = true;

      // TODO: ATENCAO AQUI
      window.apiLeadzy = await assembleAPI();

      return window.apiLeadzy;
      // debug('full ready to use');
      // await internalEv.emitAsync('webpack.full_ready').catch(() => null);
    };

    const id = Date.now();

    chunk.push([
      [id],
      {},
      (__webpack_require__) => {
        webpackRequire = __webpack_require__;

        queueMicrotask(() => injectFunction(__webpack_require__));
      },
    ]);
  }
  injectLoader();

  const sourceModuleMap = new Map();

  function moduleSource(moduleId) {
    if (loaderType !== "webpack") {
      return "";
    }

    if (!webpackRequire.m[moduleId]) {
      return "";
    }

    if (sourceModuleMap.has(moduleId)) {
      return sourceModuleMap.get(moduleId);
    }

    const source = webpackRequire.m[moduleId].toString();

    sourceModuleMap.set(moduleId, source);
    return source;
  }

  const pureComponentMap = new Map();

  function isReactComponent(moduleId) {
    if (pureComponentMap.has(moduleId)) {
      return pureComponentMap.get(moduleId);
    }

    const ignoreRE = /\w+\.(Pure)?Component\s*\{/;

    const source = moduleSource(moduleId);

    const isPure = ignoreRE.test(source);

    pureComponentMap.set(moduleId, isPure);
    return isPure;
  }

  function searchId(condition, reverse = false) {
    let ids = Object.keys(webpackRequire.m);

    if (reverse) {
      ids = ids.reverse();
    }

    // // eslint-disable-next-line no-unused-vars
    const timer = setTimeout(() => {
      // console.log(`Searching for: ${condition.toString()}`);
    }, 500);

    for (const moduleId of ids) {
      if (isReactComponent(moduleId)) {
        continue;
      }

      try {
        const module = webpackRequire(moduleId);

        if (condition(module, moduleId)) {
          // console.log(`Module found: ${moduleId} - ${condition.toString()}`);
          clearTimeout(timer);
          return moduleId;
        }
      } catch (error) {
        continue;
      }
    }

    ids = Object.keys(fallbackModules);

    for (const moduleId of ids) {
      try {
        const module = fallbackModules[moduleId];

        if (condition(module, moduleId)) {
          // debug(`Fallback Module found: ${moduleId} - ${condition.toString()}`);
          clearTimeout(timer);
          return moduleId;
        }
      } catch (error) {
        continue;
      }
    }

    return null;
  }

  function loadModule(moduleId) {
    const module = !/^fallback_/.test(moduleId)
      ? webpackRequire(moduleId)
      : fallbackModules[moduleId];

    return module;
  }

  // eslint-disable-next-line no-unused-vars
  function search(condition, reverse = false) {
    const moduleId = searchId(condition, reverse);

    if (!moduleId) {
      return null;
    }

    return loadModule(moduleId);
  }

  // API ASSEMBLER FUNCTION
  async function assembleAPI() {
    if (isInjected && isReady) {
      try {
        const reducerFunction = (acumulador, element) => {
          const module = search(element.conditions);
          if (!module) return acumulador;

          const moduleProperties = element.properties
            ? element.properties(module)
            : element.conditions(module);

          if (moduleProperties) {
            if (element.id === "Store") {
              acumulador = { ...acumulador, ...moduleProperties };
            } else {
              acumulador[element.id] = moduleProperties;
            }
          }

          return acumulador;
        };

        mountedApiLeadzy = requiredModules.reduce(reducerFunction, {});

        return mountedApiLeadzy;
      } catch (error) {
        console.error(error);
      }
    } else {
      console.error('API not ready yet. Please wait for "isReady"');
    }
  }
}

// AUXILIARY FUNCTIONS
function compare(v1, v2, operator = ">=") {
  const parseComplexVersion = (version) => {
    const parts = version.split(".");
    return parts
      .map((part) => {
        // Splitting again on non-digit characters to handle versions like '2.3000.1012766999'
        return part.split(/[^0-9]+/).map(Number);
      })
      .flat();
  };

  const v1parts = parseComplexVersion(v1);
  const v2parts = parseComplexVersion(v2);

  // Normalize the length of version parts arrays
  const maxLength = Math.max(v1parts.length, v2parts.length);
  for (let i = 0; i < maxLength; i++) {
    if (v1parts[i] === undefined) v1parts[i] = 0;
    if (v2parts[i] === undefined) v2parts[i] = 0;
  }

  for (let i = 0; i < maxLength; i++) {
    if (v1parts[i] > v2parts[i]) return operator === ">=" || operator === ">";
    if (v1parts[i] < v2parts[i]) return operator === "<=" || operator === "<";
  }

  // If all components are equal, the only operators that return true should be '>=', '<=', '=='
  return operator === ">=" || operator === "<=" || operator === "==";
}

const requiredModules = [
  //? INICIO - MODULES USED
  {
    id: "Store",
    conditions: (e) =>
      e.default && e.default.Chat && e.default.Msg ? e.default : null,
  },
  {
    id: "ChatStates",
    conditions: (e) =>
      e.sendChatStatePaused &&
      e.sendChatStateRecording &&
      e.sendChatStateComposing
        ? e
        : null,
  },
  {
    id: "sendTextMsgToChat",
    conditions: (e) => (e.sendTextMsgToChat ? e.sendTextMsgToChat : null),
  },
  { id: "SANITIZED_VERSION_STR", conditions: (e) => e.SANITIZED_VERSION_STR },

  {
    id: "MediaPrep",
    // prepRawMedia now lives in WAWebPrepRawMedia (WA-JS #3732).
    // Keep the sender alias compatible with both split and aggregate modules.
    conditions: (e) => (typeof e.prepRawMedia === "function" ? e : null),
  },
  {
    id: "MediaCollection",
    conditions: (e) =>
      e.default &&
      e.default.prototype &&
      e.default.prototype.processAttachments !== void 0
        ? e.default
        : null,
  },
  { id: "MediaProcess", conditions: (e) => (e.BLOB ? e : null) },

  {
    id: "OpaqueData",
    conditions: (e) => (e.default && e.default.createFromData ? e : null),
    properties: (e) => e.default,
  },
  {
    id: "WidFactory",
    conditions: (e) =>
      e.isWidlike && e.createWid && e.createWidFromWidLike ? e : null,
  },
  {
    id: "ComposeBox",
    conditions: (module) =>
      module.ComposeBoxActions ? module.ComposeBoxActions : null,
  },
  {
    id: "Cmd",
    conditions: (module) => (module.Cmd ? module.Cmd : null),
  },
];

export { mountLeadzyApi };
