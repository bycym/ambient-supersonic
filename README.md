# SuperSonic WebPort Project

A webport of the original ambient and granular patches.


## Running the Server

You can launch a local static file server immediately without a permanent installation using `npx`:

```bash
npx serve .
```

Alternatively, if you run `npm install` first, you can use the configured package script shortcut:

```bash
npm start
```

Once running, navigate to the local address provided in your terminal (usually `http://localhost:3000`) to test your audio implementation.

## To build
```shell
/Applications/SuperCollider.app/Contents/MacOS/sclang ./supercollider_standalone/webport/compile/compile_ambient.scd
```


## 🚀 Automated Deployment Architecture

You should **not** push manual changes or edit files directly in this repository. 

This repository is strictly a deployment target. Content is managed completely via automated Continuous Integration (CI) tracking from the development repository:

```text
[ bycym/brain-noise ] (Source Code & SynthDefs)
         │
         ▼ (GitHub Actions Workflow via Fine-Grained PAT)
[ bycym/ambient-supersonic ] (This Repository ──► Live GitHub Pages Site)
```

Whenever updates or changes are pushed to the main branch of `bycym/brain-noise`, a GitHub Actions workflow:
1. Validates code assets.
2. Injects required platform security modules.
3. Overwrites and updates the `gh-pages` branch of this repository to refresh the live site.

---

## 🛠️ Cross-Origin Isolation Optimization

SuperSonic relies heavily on WebAssembly and high-performance threading via browser `SharedArrayBuffer` mechanisms to keep digital signal processing (DSP) smooth and click-free. 

Because standard static GitHub Pages hosting environments do not allow developers to configure or dispatch custom backend server headers, this repository uses a browser-level proxy patch:
* **Service Worker Bypass:** The repository serves a bundled script (`coi-serviceworker.js`). 
* **Mechanism:** When a user visits the live site, this script intercepts local file requests inside their browser tab and dynamically appends `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp` variables natively.
* **Result:** This tricks the browser engine into authorizing high-tier multi-threaded processing allocations safely without changing GitHub infrastructure.

---

## 🎵 Local Testing & Verification

If you ever duplicate this architecture or need to inspect the live build configuration locally on your development machine, ensure you preserve the Cross-Origin headers, or the underlying WebAssembly pipeline will crash.

1. Ensure you have Node.js installed.
2. Run a static local server configured to pass the security architecture:
   ```bash
   npx serve .
   ```
3. Ensure a `serve.json` file is present locally with header configurations if running outside of the GitHub Actions sandbox environment:
   ```json
   {
     "headers": [
       {
         "source": "**/*",
         "headers": [
           { "key": "Cross-Origin-Opener-Policy", "value": "same-origin" },
           { "key": "Cross-Origin-Embedder-Policy", "value": "require-corp" }
         ]
       }
     ]
   }
   ```

## License
This project is made available under the terms of the Apache License Version 2.0. See the `LICENSE` file for more details.
