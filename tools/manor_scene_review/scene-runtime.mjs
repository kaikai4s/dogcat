import * as THREE from 'three';
import {OrbitControls} from 'three/addons/controls/OrbitControls.js';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';
import {createValleyNature} from './nature-effects.mjs';
import {createBuildSamples} from './build-samples.mjs';
window.THREE={...THREE,OrbitControls,GLTFLoader,createValleyNature,createBuildSamples};
