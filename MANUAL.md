# Manual de uso — pxpipe

**pxpipe** es un proxy local que recorta los tokens de entrada de Claude Code
transformando el contenido voluminoso (system prompt, tool docs e historial
antiguo) en imágenes PNG densas. El canal de visión cobra por tamaño de píxel,
no por texto, así que ~92 000 caracteres caben en ~4 761 tokens de imagen.
Ahorro típico: **−59 a −70 %** del coste de entrada en tráfico real de Claude
Code. El modelo sigue respondiendo con texto; pxpipe **solo comprime la
petición, nunca la respuesta**.

> Modelo objetivo por defecto: **Claude Fable 5** (y GPT 5.6). Opus 4.7/4.8 y
> GPT 5.5 leen peor los renders densos y están desactivados por defecto (opt-in).

---

## Tabla de contenidos

1. [Requisitos previos](#1-requisitos-previos)
2. [Instalación](#2-instalación)
3. [Arrancar el proxy](#3-arrancar-el-proxy)
4. [Conectar Claude Code](#4-conectar-claude-code)
5. [Dashboard](#5-dashboard)
6. [Verificar que está comprimiendo](#6-verificar-que-está-comprimiendo)
7. [Variables de entorno](#7-variables-de-entorno)
8. [Control en vivo](#8-control-en-vivo)
9. [Modelos soportados y alcance](#9-modelos-soportados-y-alcance)
10. [Comportamiento con subagentes](#10-comportamiento-con-subagentes)
11. [Modo export (sin proxy)](#11-modo-export-sin-proxy)
12. [Solución de problemas](#12-solución-de-problemas)
13. [Detener el proxy](#13-detener-el-proxy)
14. [Cheatsheet](#14-cheatsheet)

---

## 1. Requisitos previos

| Requisito | Versión / detalle |
|---|---|
| **Node.js** | `>= 18` |
| **pnpm** | `10.21.0` (recomendado; cualquier pnpm reciente sirve) |
| **Claude Code CLI** | instalado (`claude` en el PATH) |
| **Acceso a la API** | una cuenta Anthropic con clave/oAuth que Claude Code use normalmente |
| **SO** | macOS, Linux o Windows (esta máquina corre en Windows + Git Bash) |

> pxpipe **no** necesita tu clave de API. Reenvía de forma transparente las
> cabeceras de autenticación que envía Claude Code. Solo transforma el cuerpo
> del request.

Instalar pnpm (si no lo tienes):
```bash
npm install -g pnpm@10.21.0
```

---

## 2. Instalación

Tres caminos. Elige uno.

### A) Desde este repo clonado (recomendado para esta máquina)

```bash
git clone https://github.com/akumrazor/pxpipe.git
cd pxpipe
pnpm install
```

Luego puedes:
- **Modo dev** (sin build, recarga en caliente): `pnpm dev:node`
- **Build de producción** + bin: `pnpm build && node bin/cli.js`

### B) Sin clonar (paquete publicado)

```bash
npx pxpipe-proxy          # descarga y arranca el proxy en 127.0.0.1:47821
```

### C) Build del Worker (Cloudflare, opcional)

```bash
pnpm install
pnpm build
pnpm deploy:worker        # requiere wrangler login
```

---

## 3. Arrancar el proxy

En una terminal:

```bash
cd pxpipe
pnpm dev:node             # o: pnpm build && node bin/cli.js
```

Salida esperada:

```
[pxpipe] listening on http://127.0.0.1:47821
[pxpipe] anthropic upstream → https://api.anthropic.com
[pxpipe] openai upstream → https://api.openai.com
[pxpipe] tracking events → ~/.pxpipe/events.jsonl
[pxpipe] dashboard → http://127.0.0.1:47821/
```

Deja esa terminal abierta: ahí se loguea cada request.

> El CLI **solo** acepta `--help` y `--version`. Todo ajuste va por variables
> de entorno (sección 7). Ejecuta `node bin/cli.js --help` para ver la lista.

---

## 4. Conectar Claude Code

En **otra** terminal (Git Bash):

```bash
ANTHROPIC_BASE_URL=http://127.0.0.1:47821 claude
```

Eso redirige todo el tráfico de Claude Code a través del proxy. Tu clave/oAuth
de Anthropic sigue usándose como siempre; pxpipe la reenvía sin tocarla.

**Otros shells en Windows** (misma variable, sintaxis distinta):

```powershell
# PowerShell
$env:ANTHROPIC_BASE_URL="http://127.0.0.1:47821"; claude
```
```cmd
:: cmd.exe
set ANTHROPIC_BASE_URL=http://127.0.0.1:47821 && claude
```

Para hacer el redireccionamiento permanente, define la variable en tu perfil de
shell o en las variables de entorno del sistema.

---

## 5. Dashboard

Abre **<http://127.0.0.1:47821/>** en el navegador. Muestra:

- Tokens ahorrados y % end-to-end (medido contra un `count_tokens` gratis por request).
- Cada conversión texto → imagen, lado a lado.
- **Kill switch** para desactivar la compresión en vivo.
- **Chips de modelo** para activar/desactivar familias (Fable, GPT, Opus…).
- Sesiones, stats y limpieza de logs.

> El dashboard **no tiene autenticación**. Por defecto el proxy escucha solo en
> `127.0.0.1` (loopback). No expongas el puerto a la LAN salvo que sepas lo que
> haces.

---

## 6. Verificar que está comprimiendo

Mientras usas Claude Code, en la terminal del proxy aparece una línea por
request. Ejemplo de request **comprimida**:

```
POST /v1/messages → 200 (1234ms) compressed 48000ch → 2img/91234B (tr+1) tokens=2700+350 cache_read=...
```

Significados de las etiquetas:

| Etiqueta | Qué significa |
|---|---|
| `compressed Nch → Mimg/KB` | se convirtió texto a imágenes |
| `tr+N` | se imagearon N bloques `tool_result` |
| `rem+N` | se imagearon N recordatorios |
| `unsupported_model` | el modelo no está en el allowlist → pasa como texto |
| `unsupported_path` / `unsupported_method` | ruta/método no elegible → pasa intacto |

Los eventos se guardan en `~/.pxpipe/events.jsonl` (una línea por request, con
tokens reales vs. contrafactuales, precio, etc.).

---

## 7. Variables de entorno

El proxy lee estas variables al arrancar (`PXPIPE_MODELS` se re-lee por request,
así que cambia en caliente):

| Variable | Default | Para qué |
|---|---|---|
| `PORT` | `47821` | Puerto de escucha |
| `HOST` | `127.0.0.1` | Interfaz (`0.0.0.0` = expuesto; ⚠️ dashboard sin auth) |
| `ANTHROPIC_UPSTREAM` | `https://api.anthropic.com` | Base URL upstream de Anthropic |
| `OPENAI_UPSTREAM` | `https://api.openai.com` | Base URL upstream de OpenAI |
| `OPENAI_API_KEY` | (reenviada) | Clave OpenAI opcional (si no, se reenvía la del cliente) |
| `PXPIPE_UPSTREAM` | — | Base URL común para ambas familias |
| `PXPIPE_MODELS` | `claude-fable-5,gpt-5.6` | Allowlist de modelos a imaginar (CSV); `off` desactiva |
| `PXPIPE_DISABLE` | (off) | `1` = passthrough total (sigue logueando uso) |
| `PXPIPE_LOG` | `~/.pxpipe/events.jsonl` | Ruta del log JSONL |
| `PXPIPE_CONFIG` | `~/.config/pxpipe/config.json` | Config JSON (ej. `{"models": [...]}`) |
| `PXPIPE_DUMP_DIR` | (off) | Carpeta para volcar cada PNG renderizado (debug) |
| `PXPIPE_PROVIDER` | — | `cloudflare-ai-gateway` para enrutar ambas familias por un gateway |
| `PXPIPE_GATEWAY_BASE_URL` | — | URL del gateway (requerido con `PXPIPE_PROVIDER`) |
| `PXPIPE_GATEWAY_HEADERS` | — | Cabeceras extra: objeto JSON o `k=v;k2=v2` |

Ejemplo: arrancar en otro puerto y volcando PNGs:
```bash
PORT=5000 PXPIPE_DUMP_DIR=./dump pnpm dev:node
```

---

## 8. Control en vivo

Sin reiniciar el proxy:

- **Apagar/encender la compresión:** botón **kill switch** del dashboard, o
  arrancar con `PXPIPE_DISABLE=1`.
- **Cambiar modelos imageados:** los **chips** del dashboard, o ajustar
  `PXPIPE_MODELS` (se re-lee en cada request).
- **Desactivar todo:** `PXPIPE_MODELS=off`.

Todo lo que no esté en el allowlist pasa **byte-identical** como texto. La
decisión de imaginar o no se toma **por request individual**, mirando el campo
`model`.

---

## 9. Modelos soportados y alcance

**Por defecto se imagean:** `claude-fable-5` y `gpt-5.6` (lectores fiables de
renders densos).

**Opt-in (lectores peores, hay que añadirlos a `PXPIPE_MODELS`):**
- `claude-opus-4-7`, `claude-opus-4-8` — fallos silenciosos en strings exactos.
- `gpt-5.5` — degradación con contexto imageado.

**Qué se comprime** (cada bloque, tras una puerta de rentabilidad por request):
1. Bloques grandes de `tool_result` (> ~6k chars de contenido denso).
2. Historial antiguo colapsado (los turns recientes siempre quedan como texto).
3. El slab estático: system prompt + tool docs.

**Nunca se toca:** la salida del modelo (es la response), los turns recientes,
la prosa dispersa y los bloques pequeños. Lo que no gana tokens, queda como
texto.

> Tags de variante como `[1m]` se ignoran antes de comparar el modelo:
> `claude-fable-5[1m]` se trata como `claude-fable-5`.

---

## 10. Comportamiento con subagentes

**Importante:** el ser Fable del agente principal **no se propaga** a los
subagentes. La decisión es **por request, mirando solo el `model` de esa
petición**, sin estado ni árbol de agentes.

| Request | ¿Se imagea? |
|---|---|
| Agente principal en Fable | ✅ Sí |
| Subagente cuyo modelo es Fable | ✅ Sí |
| Subagente en Sonnet / Opus / Haiku | ❌ No (pasa como texto) |
| Modelo ilegible | ❌ No (fail-closed → texto) |

Esto es el **escape hatch** intencional: enruta trabajo byte-exacto a un
subagente no-allowlist para tener una zona sin pérdida dentro de la misma
sesión:

```bash
CLAUDE_CODE_SUBAGENT_MODEL=claude-sonnet-4-6     # entorno
# o en el frontmatter del agente:  model: sonnet
```

---

## 11. Modo export (sin proxy)

`pxpipe export` renderiza archivos o diffs a PNG listos para pegar en cualquier
chat (no arranca el servidor):

```bash
node bin/cli.js export src/                 # un directorio
node bin/cli.js export --git                # cambios sin commitear
node bin/cli.js export --diff HEAD~3        # últimos 3 commits
node bin/cli.js export --include "*.ts" src # filtrar por glob
cat file.txt | node bin/cli.js export --stdin
node bin/cli.js export --help               # todas las opciones
```

Salida en `<tmp>/pxpipe-export-XXXXXX/`:
- `page-NNN.png` — páginas renderizadas.
- `prompt.txt` — instrucción lista para pegar.
- `factsheet.txt` — strings verbatim (paths, SHAs, ids, números).
- `manifest.json` — metadata + informe de tokens.

---

## 12. Solución de problemas

**"Nada se comprime / todo dice `unsupported_model`"**
Tu Claude Code está usando un modelo fuera del allowlist. Confírmalo en el
dashboard (chip del modelo) o con `PXPIPE_MODELS`. Para Fable, el modelo debe
ser `claude-fable-5`.

**Errores 401/403 del upstream**
pxpipe no añade auth; reenvía la del cliente. Asegúrate de que Claude Code tenga
su clave/oAuth configurada como siempre. Si usas un gateway propio, apunta
`ANTHROPIC_UPSTREAM` a él.

**Puerto ocupado (`EADDRINUSE`)**
Cambia de puerto: `PORT=5000 pnpm dev:node`.

**"did you forget to `npm run build`?"**
Estás corriendo `node bin/cli.js` sin `dist/`. Haz `pnpm build` antes, o usa
`pnpm dev:node` (no requiere build).

**Quiero ver exactamente qué ve el modelo**
Arranca con `PXPIPE_DUMP_DIR=./dump` y revisa los PNG volcados.

**El proxy parece no recibir tráfico**
Verifica que Claude Code apunta al proxy:
```bash
echo $ANTHROPIC_BASE_URL        # debe ser http://127.0.0.1:47821
```
Y que el proxy escucha: abre <http://127.0.0.1:47821/>.

**¿Es seguro para hashes/IDs/secretos?**
**No.** La lectura verbatim de strings exactos en imágenes densas es poco
fiable (13/15 en Fable, 0/15 en Opus para hex de 12 chars). Los valores
byte-exactos deben ir como texto (los turns recientes y los `factsheet` los
protegen). Para trabajo crítico, usa el escape hatch de subagentes (sección 10).

---

## 13. Detener el proxy

`Ctrl+C` en la terminal del proxy. Cierra limpiamente: flushea el tracker,
cierra sockets idle y fuerza el cierre de conexiones en vuelo tras ~1.5 s. Un
segundo `Ctrl+C` sale al momento.

---

## 14. Cheatsheet

```bash
# --- instalación ---
git clone https://github.com/akumrazor/pxpipe.git && cd pxpipe
pnpm install

# --- arrancar ---
pnpm dev:node                                # o: pnpm build && node bin/cli.js

# --- conectar Claude Code (otra terminal) ---
ANTHROPIC_BASE_URL=http://127.0.0.1:47821 claude

# --- dashboard ---
# http://127.0.0.1:47821/

# --- parar ---
# Ctrl+C en la terminal del proxy

# --- export (sin proxy) ---
node bin/cli.js export --git
node bin/cli.js export --diff HEAD~3

# --- variables útiles ---
# PORT=5000 PXPIPE_MODELS=claude-fable-5,gpt-5.6 PXPIPE_DUMP_DIR=./dump pnpm dev:node
```

---

*Manual para el fork `akumrazor/pxpipe` (upstream `teamchong/pxpipe`). Este
documento **sí** se versiona en el repo (no está en `.gitignore`), para tenerlo
disponible al clonar en otra máquina.*
