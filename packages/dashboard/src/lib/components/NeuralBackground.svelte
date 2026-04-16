<script lang="ts">
  import { onMount } from 'svelte';
  import * as THREE from 'three';

  let canvas: HTMLCanvasElement;

  onMount(() => {
    const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(55, window.innerWidth / window.innerHeight, 0.1, 500);
    camera.position.z = 45;

    // Mouse tracking
    let mx = 0, my = 0;
    const onMouseMove = (e: MouseEvent) => {
      mx = (e.clientX / window.innerWidth - 0.5) * 2;
      my = (e.clientY / window.innerHeight - 0.5) * 2;
    };
    window.addEventListener('mousemove', onMouseMove);

    // Particles
    const N = 350;
    const pos = new Float32Array(N * 3);
    const colors = new Float32Array(N * 3);
    const sizes = new Float32Array(N);
    const vel: { x: number; y: number; z: number }[] = [];

    for (let i = 0; i < N; i++) {
      pos[i * 3] = (Math.random() - 0.5) * 100;
      pos[i * 3 + 1] = (Math.random() - 0.5) * 80;
      pos[i * 3 + 2] = (Math.random() - 0.5) * 50;
      const brightness = 0.3 + Math.random() * 0.7;
      colors[i * 3] = 0.13 * brightness;
      colors[i * 3 + 1] = 0.77 * brightness;
      colors[i * 3 + 2] = 0.37 * brightness;
      sizes[i] = 0.15 + Math.random() * 0.4;
      vel.push({
        x: (Math.random() - 0.5) * 0.015,
        y: (Math.random() - 0.5) * 0.015,
        z: (Math.random() - 0.5) * 0.008,
      });
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geo.setAttribute('size', new THREE.BufferAttribute(sizes, 1));

    const mat = new THREE.ShaderMaterial({
      uniforms: { time: { value: 0 } },
      vertexShader: `
        attribute float size;
        attribute vec3 color;
        varying vec3 vColor;
        varying float vAlpha;
        void main() {
          vColor = color;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = size * (250.0 / -mv.z);
          gl_Position = projectionMatrix * mv;
          vAlpha = smoothstep(180.0, 15.0, -mv.z);
        }
      `,
      fragmentShader: `
        varying vec3 vColor;
        varying float vAlpha;
        void main() {
          float d = length(gl_PointCoord - vec2(0.5));
          if (d > 0.5) discard;
          float glow = 1.0 - smoothstep(0.0, 0.5, d);
          gl_FragColor = vec4(vColor, glow * vAlpha * 0.7);
        }
      `,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });

    const pts = new THREE.Points(geo, mat);
    scene.add(pts);

    // Connection lines
    const maxConn = 600;
    const linePos = new Float32Array(maxConn * 6);
    const lineColors = new Float32Array(maxConn * 6);
    const lineGeo = new THREE.BufferGeometry();
    lineGeo.setAttribute('position', new THREE.BufferAttribute(linePos, 3));
    lineGeo.setAttribute('color', new THREE.BufferAttribute(lineColors, 3));
    const lineMat = new THREE.LineBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0.12,
      blending: THREE.AdditiveBlending,
    });
    const lines = new THREE.LineSegments(lineGeo, lineMat);
    scene.add(lines);

    function updateConnections() {
      const p = geo.attributes.position.array as Float32Array;
      let ci = 0;
      for (let i = 0; i < N && ci < maxConn; i++) {
        for (let j = i + 1; j < Math.min(i + 12, N) && ci < maxConn; j++) {
          const dx = p[i * 3] - p[j * 3];
          const dy = p[i * 3 + 1] - p[j * 3 + 1];
          const dz = p[i * 3 + 2] - p[j * 3 + 2];
          const dist = dx * dx + dy * dy + dz * dz;
          if (dist < 180) {
            const fade = 1 - dist / 180;
            const c = fade * 0.25;
            linePos[ci * 6] = p[i * 3]; linePos[ci * 6 + 1] = p[i * 3 + 1]; linePos[ci * 6 + 2] = p[i * 3 + 2];
            linePos[ci * 6 + 3] = p[j * 3]; linePos[ci * 6 + 4] = p[j * 3 + 1]; linePos[ci * 6 + 5] = p[j * 3 + 2];
            lineColors[ci * 6] = 0.13 * c; lineColors[ci * 6 + 1] = 0.77 * c; lineColors[ci * 6 + 2] = 0.37 * c;
            lineColors[ci * 6 + 3] = 0.13 * c; lineColors[ci * 6 + 4] = 0.77 * c; lineColors[ci * 6 + 5] = 0.37 * c;
            ci++;
          }
        }
      }
      for (let i = ci * 6; i < maxConn * 6; i++) { linePos[i] = 0; lineColors[i] = 0; }
      lineGeo.attributes.position.needsUpdate = true;
      lineGeo.attributes.color.needsUpdate = true;
      lineGeo.setDrawRange(0, ci * 2);
    }

    let frame = 0;
    let tx = 0, ty = 0;

    function animate() {
      requestAnimationFrame(animate);
      const p = geo.attributes.position.array as Float32Array;

      for (let i = 0; i < N; i++) {
        p[i * 3] += vel[i].x;
        p[i * 3 + 1] += vel[i].y;
        p[i * 3 + 2] += vel[i].z;
        if (Math.abs(p[i * 3]) > 50) vel[i].x *= -1;
        if (Math.abs(p[i * 3 + 1]) > 40) vel[i].y *= -1;
        if (Math.abs(p[i * 3 + 2]) > 25) vel[i].z *= -1;
      }
      geo.attributes.position.needsUpdate = true;

      if (frame % 25 === 0) updateConnections();

      tx += (mx * 6 - tx) * 0.03;
      ty += (-my * 4 - ty) * 0.03;
      camera.position.x += (tx - camera.position.x) * 0.05;
      camera.position.y += (ty - camera.position.y) * 0.05;
      camera.lookAt(0, 0, 0);

      pts.rotation.y += 0.0001;
      mat.uniforms.time.value = frame * 0.01;

      renderer.render(scene, camera);
      frame++;
    }

    updateConnections();
    animate();

    const onResize = () => {
      camera.aspect = window.innerWidth / window.innerHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(window.innerWidth, window.innerHeight);
    };
    window.addEventListener('resize', onResize);

    return () => {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('resize', onResize);
      renderer.dispose();
    };
  });
</script>

<canvas bind:this={canvas} class="fixed inset-0 w-full h-full pointer-events-none z-0"></canvas>
