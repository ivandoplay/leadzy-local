/* ============================================================================
 * Entrada do service worker.
 * ----------------------------------------------------------------------------
 * Carrega o guarda de rede primeiro e depois o service worker original, que
 * permanece intocado em js/service-worker.js.
 *
 * Imports estáticos são avaliados na ordem declarada, então o guarda está
 * instalado antes de o original registrar qualquer listener.
 * ========================================================================== */

import "./sw-guard.js";
import "./service-worker.js";
