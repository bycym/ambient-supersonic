# SuperSonic WebPort Project

The public-facing production host for the Ambient SuperSonic web environment. 

This repository serves as a static target deployment site. It utilizes a WebAssembly port of **`scsynth`** (SuperCollider’s real-time synthesis engine) to compile and evaluate audio directly inside modern web browsers.


<img width="1157" height="798" alt="kép" src="https://github.com/user-attachments/assets/1f310c2e-5326-4323-80bf-1ba0c80d307b" />

<img width="2320" height="2998" alt="kép" src="https://github.com/user-attachments/assets/d1560d6e-c635-4ba3-8e65-53091926fb2f" />

## Running the Server

You can launch a local static file server immediately without a permanent installation using `npx`:

```bash
npx serve .
```

Alternatively, if you run `npm install` first, you can use the configured package script shortcut:

```bash
npm start
```

## License
This project is made available under the terms of the Apache License Version 2.0. See the `LICENSE` file for more details.
