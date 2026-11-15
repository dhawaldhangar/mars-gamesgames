import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Camera, ChevronDown, ChevronUp, Loader2, ShieldCheck, Wrench, Wind } from 'lucide-react';
import { RoverPhase, RoverMissionTarget } from '../three/MarsOutpostScene';
import { RoverCameraPhoto } from '../utils/nasaApi';
import { missionAudio } from '../utils/audio';
import roverCamRegeneratedImg from '../assets/images/regenerated_image_1794686128270.jpg';

type GlitchPhase = 'idle' | 'shift-a' | 'shift-b' | 'settle';

interface RoverCamWidgetProps {
  currentSol: number;
  roverPhase: RoverPhase;
  targetLabel: string | null;
  photo: RoverCameraPhoto | null;
  photoHistory: RoverCameraPhoto[];
  loading: boolean;
  collapsed: boolean;
  hiddenByInspector: boolean;
  canDeploy: boolean;
  powerKwh: number;
  onToggleCollapse: () => void;
  onSelectPhoto: (photo: RoverCameraPhoto) => void;
  onQuickDeploy: (target: RoverMissionTarget) => void;
}

export const RoverCamWidget: React.FC<RoverCamWidgetProps> = ({
  currentSol,
  roverPhase,
  targetLabel,
  photo,
  photoHistory,
  loading,
  collapsed,
  hiddenByInspector,
  canDeploy,
  powerKwh,
  onToggleCollapse,
  onSelectPhoto,
  onQuickDeploy,
}) => {
  const [imgFailed, setImgFailed] = useState(false);
  const [failedThumbIds, setFailedThumbIds] = useState<number[]>([]);
  const [glitchPhase, setGlitchPhase] = useState<GlitchPhase>('idle');

  const imgRef = useRef<HTMLImageElement | null>(null);
  const glitchedPhotoRef = useRef<RoverCameraPhoto | null>(null);
  const glitchTimersRef = useRef<number[]>([]);

  const clearGlitchTimers = useCallback(() => {
    for (const id of glitchTimersRef.current) {
      window.clearTimeout(id);
    }
    glitchTimersRef.current = [];
  }, []);

  const triggerGlitch = useCallback(
    (targetPhoto: RoverCameraPhoto | null) => {
      if (
        !targetPhoto ||
        targetPhoto.sourceMode === 'SYNTHETIC_FALLBACK' ||
        targetPhoto.sourceMode === 'LOCAL_ARCHIVE'
      ) {
        return;
      }
      if (glitchedPhotoRef.current === targetPhoto) return;
      glitchedPhotoRef.current = targetPhoto;

      clearGlitchTimers();
      setGlitchPhase('shift-a');
      const t1 = window.setTimeout(() => {
        setGlitchPhase('shift-b');
        const t2 = window.setTimeout(() => {
          setGlitchPhase('settle');
          const t3 = window.setTimeout(() => {
            setGlitchPhase('idle');
          }, 110);
          glitchTimersRef.current.push(t3);
        }, 110);
        glitchTimersRef.current.push(t2);
      }, 110);
      glitchTimersRef.current.push(t1);
    },
    [clearGlitchTimers]
  );

  useEffect(() => clearGlitchTimers, [clearGlitchTimers]);

  useEffect(() => {
    setImgFailed(false);
  }, [photo]);

  useEffect(() => {
    if (!photo || collapsed || imgFailed) return;
    const imgEl = imgRef.current;
    if (imgEl && imgEl.complete && imgEl.naturalWidth > 0) {
      triggerGlitch(photo);
    }
  }, [photo, collapsed, imgFailed, triggerGlitch]);

  if (hiddenByInspector) return null;

  const isRoverActive = roverPhase !== 'idle';
  const statusText =
    roverPhase === 'outbound'
      ? 'TRANSIT'
      : roverPhase === 'working'
      ? 'LASER SCAN'
      : roverPhase === 'returning'
      ? 'RETURNING'
      : photo
      ? 'FHAZ READY'
      : 'STANDBY';

  const telemetryReadout = isRoverActive
    ? 'AUTONAV: ACTIVE | SPEED: 4.2 cm/s | MMRTG: 110W'
    : 'AUTONAV: STANDBY | SPEED: 0.0 cm/s | MMRTG: 110W';

  const displaySrc =
    photo && !imgFailed && photo.sourceMode !== 'SYNTHETIC_FALLBACK'
      ? photo.imgSrc
      : roverCamRegeneratedImg;

  const imgGlitchClasses =
    glitchPhase === 'shift-a'
      ? 'grayscale contrast-150 brightness-150 translate-x-[3px] -skew-x-3 opacity-85 scale-[1.02]'
      : glitchPhase === 'shift-b'
      ? 'grayscale contrast-150 brightness-125 -translate-x-[2px] skew-x-2 opacity-95 scale-[1.01]'
      : glitchPhase === 'settle'
      ? 'grayscale contrast-125 brightness-110 translate-x-[1px] skew-x-0 opacity-100 scale-100'
      : 'grayscale contrast-125 brightness-100 translate-x-0 skew-x-0 opacity-100 scale-100';

  const flashOverlayClasses =
    glitchPhase === 'shift-a'
      ? 'opacity-75 -translate-y-1 bg-gradient-to-b from-cyan-400/25 via-fuchsia-500/25 to-cyan-300/20'
      : glitchPhase === 'shift-b'
      ? 'opacity-50 translate-y-1 bg-gradient-to-b from-fuchsia-400/20 via-transparent to-cyan-400/25'
      : 'opacity-0 translate-y-0 bg-transparent';

  return (
    <aside
      data-testid="rover-cam-widget"
      aria-label="Rover Cam FHAZ"
      className="fixed top-[128px] sm:top-[122px] right-2.5 sm:right-3.5 z-20 w-[min(15.5rem,calc(100vw-1.25rem))] rounded-2xl bg-[#100918]/94 border border-cyan-400/55 shadow-2xl overflow-hidden text-slate-100"
    >
      {/* Collapsible Header Bar */}
      <button
        type="button"
        data-testid="rover-cam-toggle"
        aria-expanded={!collapsed}
        onClick={() => {
          missionAudio.playClick();
          onToggleCollapse();
        }}
        className="w-full flex items-center justify-between gap-1.5 px-2.5 py-1.5 text-left bg-[#170D24]/95 hover:bg-[#1E1130] border-b border-fuchsia-400/20 transition-colors cursor-pointer focus-visible:outline-2 focus-visible:outline-cyan-300"
      >
        <div className="flex items-center gap-1.5 min-w-0">
          <Camera className="w-3.5 h-3.5 text-cyan-300 shrink-0" aria-hidden="true" />
          <span className="text-[11px] font-semibold tracking-tight text-white whitespace-nowrap">
            Rover Cam (FHAZ)
          </span>
        </div>

        <div className="flex items-center gap-1.5 shrink-0">
          <span
            data-testid="rover-cam-status"
            className={`text-[10px] font-mono font-semibold whitespace-nowrap ${
              isRoverActive
                ? 'text-amber-300'
                : photo
                ? 'text-emerald-300'
                : 'text-cyan-300'
            }`}
          >
            {statusText}
          </span>
          {collapsed ? (
            <ChevronDown className="w-3.5 h-3.5 text-slate-300" aria-hidden="true" />
          ) : (
            <ChevronUp className="w-3.5 h-3.5 text-slate-300" aria-hidden="true" />
          )}
        </div>
      </button>

      {/* Picture-in-Picture Feed Body */}
      {!collapsed && (
        <div className="p-2 space-y-1.5">
          {/* Grayscale FHAZ Viewport */}
          <div
            data-testid="rover-cam-viewport"
            data-glitch={glitchPhase}
            className="relative aspect-[16/9] w-full rounded-xl overflow-hidden bg-[#070B14] border border-cyan-500/35"
          >
            {photo && displaySrc ? (
              <img
                ref={imgRef}
                data-testid="rover-cam-image"
                src={displaySrc}
                alt={`NASA Perseverance ${photo.cameraName} view on Sol ${photo.sol}`}
                referrerPolicy="no-referrer"
                onLoad={() => {
                  if (!imgFailed) triggerGlitch(photo);
                }}
                onError={() => setImgFailed(true)}
                className={`w-full h-full object-cover transition-[transform,opacity,filter] duration-75 ease-out motion-reduce:transition-none motion-reduce:transform-none ${imgGlitchClasses}`}
              />
            ) : (
              <div className="w-full h-full flex flex-col items-center justify-center px-3 text-center gap-1 bg-gradient-to-b from-[#170D24] to-[#070B14]">
                <Camera className="w-5 h-5 text-cyan-400/70" aria-hidden="true" />
                <p className="text-[10px] font-medium text-slate-200 leading-tight">
                  {isRoverActive
                    ? `En route: ${targetLabel ?? 'Target'}`
                    : 'FHAZ Downlink Standby'}
                </p>
                <p className="text-[9px] font-mono text-slate-400 leading-tight">
                  Deploy rover to capture Sol {currentSol} photo
                </p>
              </div>
            )}

            {/* Chromatic Sync Glitch Flash Overlay (CSS transitions) */}
            <div
              aria-hidden="true"
              className={`pointer-events-none absolute inset-0 transition-[transform,opacity] duration-75 ease-out motion-reduce:transition-none motion-reduce:opacity-0 ${flashOverlayClasses}`}
            />

            {/* Scanline & Camera Reticle Overlay */}
            <div
              className={`pointer-events-none absolute inset-0 rover-fhaz-scanlines transition-opacity duration-75 ease-out motion-reduce:transition-none ${
                glitchPhase === 'shift-a' || glitchPhase === 'shift-b' ? 'opacity-100' : 'opacity-75'
              }`}
            />

            {/* Loading Indicator */}
            {loading && (
              <div className="absolute inset-0 bg-[#070B14]/70 flex items-center justify-center gap-1.5 text-[11px] font-mono text-cyan-200">
                <Loader2 className="w-3.5 h-3.5 animate-spin text-cyan-300" aria-hidden="true" />
                <span>Downlinking FHAZ...</span>
              </div>
            )}

            {/* Bottom Scrim Metadata */}
            <div className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/90 via-black/50 to-transparent px-2 py-1 flex items-center justify-between gap-1.5 text-[9px] font-mono">
              <span data-testid="rover-cam-camera" className="text-cyan-200 truncate">
                {photo ? photo.cameraName : 'FRONT_HAZCAM_LEFT_A'}
              </span>
              <span data-testid="rover-cam-earth-date" className="text-slate-200 whitespace-nowrap">
                {photo ? `${photo.earthDate} · Sol ${photo.sol}` : `Sol ${currentSol}`}
              </span>
            </div>
          </div>

          {/* Captured FHAZ Thumbnail Strip below Rover Cam */}
          {photoHistory.length > 1 && (
            <div
              data-testid="rover-cam-gallery"
              aria-label="Captured Rover Cam photos"
              className="grid grid-cols-4 gap-1"
            >
              {photoHistory.slice(0, 4).map((item, idx) => {
                const isSelected = photo?.id === item.id;
                const thumbSrc =
                  item.sourceMode !== 'SYNTHETIC_FALLBACK' && !failedThumbIds.includes(item.id)
                    ? item.imgSrc
                    : roverCamRegeneratedImg;
                return (
                  <button
                    key={`${item.id}-${idx}`}
                    type="button"
                    data-testid={`rover-cam-thumb-${idx}`}
                    aria-label={`View Sol ${item.sol} photo ${idx + 1}`}
                    aria-pressed={isSelected}
                    onClick={() => {
                      missionAudio.playClick();
                      onSelectPhoto(item);
                    }}
                    className={`relative aspect-[16/9] rounded-md overflow-hidden border transition-all cursor-pointer focus-visible:outline-2 focus-visible:outline-cyan-300 ${
                      isSelected
                        ? 'border-cyan-300 ring-1 ring-cyan-400/70 opacity-100'
                        : 'border-slate-700/80 opacity-75 hover:opacity-100 hover:border-cyan-400/60'
                    }`}
                  >
                    <img
                      src={thumbSrc}
                      alt={`Sol ${item.sol} FHAZ thumbnail ${idx + 1}`}
                      referrerPolicy="no-referrer"
                      onError={() =>
                        setFailedThumbIds((prev) =>
                          prev.includes(item.id) ? prev : [...prev, item.id]
                        )
                      }
                      className="w-full h-full object-cover grayscale contrast-125"
                    />
                    <span className="pointer-events-none absolute bottom-0 right-0 px-1 bg-black/75 text-[8px] font-mono text-cyan-200 leading-tight">
                      S{item.sol}
                    </span>
                  </button>
                );
              })}
            </div>
          )}

          {/* Telemetry Readout */}
          <div
            data-testid="rover-cam-telemetry"
            className="rounded-lg bg-[#090612] border border-fuchsia-400/25 px-2 py-1 text-[9px] font-mono text-cyan-200 leading-tight text-center"
          >
            {telemetryReadout}
          </div>

          {/* Quick External Rover Maintenance Controls (0 Crew Radiation) */}
          <div className="flex items-center justify-between gap-1">
            <button
              type="button"
              data-testid="rover-quick-solar"
              disabled={!canDeploy || isRoverActive || powerKwh < 10}
              onClick={() =>
                onQuickDeploy({
                  kind: 'solar',
                  moduleId: 'solar',
                  label: 'Solar Array Field',
                })
              }
              className="flex-1 inline-flex items-center justify-center gap-1 px-1.5 py-1 rounded-lg bg-[#1A102A] hover:bg-[#24163A] disabled:opacity-50 disabled:cursor-not-allowed border border-cyan-400/45 text-[9.5px] font-semibold text-cyan-100 cursor-pointer whitespace-nowrap transition-colors"
              title="Deploy Rover to Clean Solar Dust (-10 kWh, 0 Rad)"
            >
              <Wrench className="w-2.5 h-2.5 text-amber-300 shrink-0" aria-hidden="true" />
              <span>Clean Dust (-10)</span>
            </button>
            <button
              type="button"
              data-testid="rover-quick-moxie"
              disabled={!canDeploy || isRoverActive || powerKwh < 10}
              onClick={() =>
                onQuickDeploy({
                  kind: 'moxie',
                  moduleId: 'moxie',
                  label: 'MOXIE Filter Core',
                })
              }
              className="flex-1 inline-flex items-center justify-center gap-1 px-1.5 py-1 rounded-lg bg-[#1A102A] hover:bg-[#24163A] disabled:opacity-50 disabled:cursor-not-allowed border border-cyan-400/45 text-[9.5px] font-semibold text-cyan-100 cursor-pointer whitespace-nowrap transition-colors"
              title="Deploy Rover to Fix MOXIE Filter (-10 kWh, 0 Rad)"
            >
              <Wind className="w-2.5 h-2.5 text-cyan-300 shrink-0" aria-hidden="true" />
              <span>Fix MOXIE (-10)</span>
            </button>
          </div>

          <div className="flex items-center justify-between gap-1.5 text-[9.5px] font-mono text-slate-400 px-0.5">
            <span className="inline-flex items-center gap-1 text-emerald-300 whitespace-nowrap">
              <ShieldCheck className="w-3 h-3 shrink-0" aria-hidden="true" />
              <span>0.00 cSv EVA</span>
            </span>
            <span className="truncate">
              {targetLabel ? targetLabel : 'Click any glowing rock'}
            </span>
          </div>
        </div>
      )}
    </aside>
  );
};
