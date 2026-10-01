"use client";

import { useEffect, useRef, useState } from "react";

interface ProductDemoProps {
  name: string;
  width: number;
  height: number;
  label: string;
  webm?: boolean;
}

/** Load clips only on screen; keep posters for reduced motion and data saving. */
export function ProductDemo({ name, width, height, label, webm = true }: ProductDemoProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [loaded, setLoaded] = useState(false);
  const [visible, setVisible] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [requested, setRequested] = useState(false);
  const [automatic, setAutomatic] = useState(false);
  const [paused, setPaused] = useState(false);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
    const connection = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection;
    const updatePreference = () => setAutomatic(!motion.matches && !connection?.saveData);
    updatePreference();
    motion.addEventListener("change", updatePreference);
    let intersecting = false;
    const updateVisibility = () => setVisible(intersecting && !document.hidden);
    const observer = new IntersectionObserver(([entry]) => {
      intersecting = entry.isIntersecting;
      updateVisibility();
    });
    observer.observe(video);
    document.addEventListener("visibilitychange", updateVisibility);
    return () => {
      observer.disconnect();
      motion.removeEventListener("change", updatePreference);
      document.removeEventListener("visibilitychange", updateVisibility);
    };
  }, []);

  useEffect(() => {
    if (visible && (automatic || requested)) setLoaded(true);
  }, [visible, automatic, requested]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    if (loaded && visible && !paused && (automatic || requested)) {
      void video.play().catch(() => setPlaying(false));
    } else {
      video.pause();
    }
  }, [loaded, visible, paused, automatic, requested]);

  return (
    <button
      type="button"
      className="block w-full border border-[var(--border)] focus-visible:outline-2 focus-visible:outline-offset-4"
      aria-label={`${label}; toggle playback`}
      aria-pressed={playing}
      onClick={() => {
        setRequested(true);
        setPaused(playing);
      }}
    >
      <video
        ref={videoRef}
        width={width}
        height={height}
        poster={`/demos/${name}.webp`}
        className="block h-auto w-full"
        aria-label={label}
        muted
        loop
        playsInline
        preload="none"
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
      >
        {loaded && webm && <source src={`/demos/${name}.webm`} type='video/webm; codecs="vp9"' />}
        {loaded && <source src={`/demos/${name}.mp4`} type="video/mp4" />}
        {label}
      </video>
    </button>
  );
}
