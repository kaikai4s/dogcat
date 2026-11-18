# 3D Manor mini-program runtime

The 3D Manor subpackage uses Three.js r162, the final release that supports both WebGL versions. The official glTF loader handles model nodes and materials. The mini-program adapter reads the shared GLB buffer directly and decodes embedded PNG/JPEG files with WeChat’s offscreen canvas. Cloud models and textures stay out of the code package.

Rebuild the CommonJS bundle and run the adapter tests:

```sh
npm ci --prefix tools/manor_mini_runtime
npm run --prefix tools/manor_mini_runtime build
node --test tests/miniprogram/manor3dRuntime.test.js
```

Keep the license next to the generated bundle. On Three.js upgrades, review the native compatibility patches in the build script and test both WebGL versions.
