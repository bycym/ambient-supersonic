# Ambient Zero WebPort

A browser version of Ambient Zero powered by SuperSonic's WebAssembly
SuperCollider server. The webport includes the Ambient Zero app, its compiled
SynthDefs, and the SuperSonic runtime. Granular Zero is not part of this app.


## Running the Server

From this directory, install dependencies once, then start
the static server with the response headers required by SuperSonic:

```bash
npm install
npm start
```

Once running, navigate to the local address provided in your terminal (usually `http://localhost:3000`) to test your audio implementation.

## Tests

```bash
npm test
```

## To build

Run the build command from the repository root:

```shell
/Applications/SuperCollider.app/Contents/MacOS/sclang ./supercollider_standalone/webport/compile/ambient/compile_ambient.scd
```


## Deployment

The repository's deployment workflow publishes this directory to the `main`
branch of `bycym/ambient-supersonic` for GitHub Pages.
It adds the cross-origin isolation service worker before publishing so the
WebAssembly audio runtime can use `SharedArrayBuffer`.

```text
[ source repository ]
        │ GitHub Actions
        ▼
[ ambient-supersonic main branch / GitHub Pages ]
```

## License
This project is made available under the terms of the Apache License Version 2.0. See the `LICENSE` file for more details.
