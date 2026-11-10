import {
  type CSSProperties,
  type KeyboardEvent,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import AudioLines from "~icons/lucide/audio-lines";
import Ellipsis from "~icons/lucide/ellipsis";
import Headphones from "~icons/lucide/headphones";
import Maximize from "~icons/lucide/maximize";
import Minimize from "~icons/lucide/minimize";
import Pause from "~icons/lucide/pause";
import PictureInPicture from "~icons/lucide/picture-in-picture-2";
import Play from "~icons/lucide/play";
import RotateCcw from "~icons/lucide/rotate-ccw";
import Volume2 from "~icons/lucide/volume-2";
import VolumeX from "~icons/lucide/volume-x";
import { useLocale } from "../../i18n";
import { copyTextToClipboard } from "../../lib/shared/clipboard";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";
import { TooltipPortalContainer } from "../ui/tooltip";
import { TooltipButton as Button } from "../ui/tooltip-button";
import { PreviewIdentityContext, PreviewToolbarMount } from "./PreviewChrome";
import { PreviewDock } from "./PreviewDock";
import { PreviewLoading, type PreviewRecovery, PreviewUnavailable } from "./PreviewFeedback";
import { usePreviewViewport } from "./usePreviewViewport";
import "./resource-media-preview.css";

const rates = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];
const finiteTime = (time: number) => (Number.isFinite(time) && time > 0 ? time : 0);
export function mediaTime(time: number) {
  const seconds = Math.floor(finiteTime(time));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return `${hours ? `${hours}:${String(minutes).padStart(2, "0")}` : minutes}:${String(seconds % 60).padStart(2, "0")}`;
}

/** Shared controls over the browser decoder. The host owns bytes, authority and Blob URLs. */
export default function ResourceMediaPreview({
  kind,
  url,
  name,
  assertCurrent,
  onDownload,
  onRetry,
  onCancel,
}: PreviewRecovery & {
  kind: "audio" | "video";
  url: string;
  name: string;
  assertCurrent: () => void;
  onCancel?: () => void;
}) {
  const { locale } = useLocale();
  const zh = locale === "zh-CN";
  const media = useRef<HTMLMediaElement | null>(null);
  const chrome = useContext(PreviewToolbarMount);
  const { sourcePaths } = useContext(PreviewIdentityContext);
  const workspaceTab = Boolean(chrome?.workspaceTab);
  const workspaceAudio = workspaceTab && kind === "audio";
  const workspaceVideo = workspaceTab && kind === "video";
  const inactive = workspaceTab && !chrome?.target;
  useEffect(() => {
    if (inactive) media.current?.pause();
  }, [inactive]);
  const authority = useRef(assertCurrent);
  useLayoutEffect(() => {
    authority.current = assertCurrent;
  }, [assertCurrent]);
  const mediaRef = useCallback((element: HTMLMediaElement | null) => {
    media.current = element;
  }, []);
  const lifetime = useRef(0);
  const { container, sideInset, viewport } = usePreviewViewport();
  const compact = viewport.width - sideInset <= 560;
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [ended, setEnded] = useState(false);
  const [ready, setReady] = useState(false);
  const [waiting, setWaiting] = useState(false);
  const [starting, setStarting] = useState(false);
  const [volume, setVolume] = useState(1);
  const [muted, setMuted] = useState(false);
  const [rate, setRate] = useState(1);
  const [fullscreen, setFullscreen] = useState(false);
  const [pip, setPip] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [buffered, setBuffered] = useState<{ start: number; end: number }[]>([]);
  const [speedOpen, setSpeedOpen] = useState(false);
  const [volumeOpen, setVolumeOpen] = useState(false);

  const current = () => {
    try {
      authority.current();
      return media.current;
    } catch {
      media.current?.pause();
      setError("此预览已失效，请重新打开文件。");
      return null;
    }
  };

  useEffect(() => {
    const element = media.current;
    const stage = container.current;
    if (!element) return;
    const generation = ++lifetime.current;
    const valid = () => {
      if (generation !== lifetime.current) return false;
      try {
        authority.current();
        return true;
      } catch {
        element.pause();
        setError("此预览已失效，请重新打开文件。");
        return false;
      }
    };
    const sync = () => {
      if (!valid()) return;
      const length = finiteTime(element.duration);
      setDuration(length);
      setTime(finiteTime(element.currentTime));
      setVolume(element.volume);
      setMuted(element.muted);
      setRate(element.playbackRate);
      setPlaying(!element.paused && !element.ended);
      setEnded(element.ended);
      if (element.readyState >= 1) setReady(true);
      const ranges = [];
      for (let i = 0; i < Math.min(element.buffered.length, 100); i++) {
        ranges.push({ start: element.buffered.start(i), end: element.buffered.end(i) });
      }
      setBuffered(ranges);
    };
    const canPlay = () => {
      if (!valid()) return;
      setWaiting(false);
      setStarting(false);
      sync();
    };
    const buffering = () => {
      if (valid() && !element.paused) setWaiting(true);
    };
    const failed = () => {
      if (!valid()) return;
      element.pause();
      setError(
        `无法播放此${kind === "video" ? "视频" : "音频"}，文件可能损坏或当前环境不支持其编码。`,
      );
    };
    const fullscreenChanged = () => setFullscreen(document.fullscreenElement === stage);
    const pipChanged = () => setPip(document.pictureInPictureElement === element);
    const events = [
      "loadedmetadata",
      "durationchange",
      "timeupdate",
      "progress",
      "volumechange",
      "ratechange",
      "play",
      "pause",
      "ended",
    ];
    for (const event of events) element.addEventListener(event, sync);
    for (const event of ["canplay", "playing", "seeked"]) element.addEventListener(event, canPlay);
    element.addEventListener("waiting", buffering);
    element.addEventListener("error", failed);
    element.addEventListener("enterpictureinpicture", pipChanged);
    element.addEventListener("leavepictureinpicture", pipChanged);
    document.addEventListener("fullscreenchange", fullscreenChanged);
    // Strict Effects can retire and reinstall this decoder without a React DOM update.
    if (element.getAttribute("src") !== url) {
      element.src = url;
      element.load();
    }
    sync();
    return () => {
      lifetime.current++;
      for (const event of events) element.removeEventListener(event, sync);
      for (const event of ["canplay", "playing", "seeked"])
        element.removeEventListener(event, canPlay);
      element.removeEventListener("waiting", buffering);
      element.removeEventListener("error", failed);
      element.removeEventListener("enterpictureinpicture", pipChanged);
      element.removeEventListener("leavepictureinpicture", pipChanged);
      document.removeEventListener("fullscreenchange", fullscreenChanged);
      element.pause();
      if (document.pictureInPictureElement === element)
        void document.exitPictureInPicture().catch(() => {});
      if (document.fullscreenElement === stage) void document.exitFullscreen().catch(() => {});
      element.removeAttribute("src");
      element.load();
    };
  }, [container, kind, url]);

  const togglePlayback = async () => {
    const element = current();
    if (!element) return;
    setNotice("");
    if (!element.paused || starting) {
      element.pause();
      setStarting(false);
      return;
    }
    const generation = lifetime.current;
    if (element.ended) element.currentTime = 0;
    setStarting(true);
    try {
      await element.play();
      if (generation === lifetime.current) {
        current();
        setStarting(false);
      }
    } catch (cause) {
      if (generation !== lifetime.current) return;
      setStarting(false);
      if (cause instanceof DOMException && cause.name === "AbortError") return;
      setNotice("播放未能开始，请再试一次。");
    }
  };
  const seek = (next: number) => {
    const element = current();
    if (!element || !duration) return;
    element.currentTime = Math.max(0, Math.min(duration, next));
    setTime(element.currentTime);
    setEnded(false);
  };
  const toggleMute = () => {
    const element = current();
    if (!element) return;
    if (!element.volume) element.volume = 1;
    element.muted = !element.muted && volume > 0;
  };
  const toggleFullscreen = async () => {
    if (!current()) return;
    try {
      if (document.fullscreenElement === container.current) await document.exitFullscreen();
      else await container.current?.requestFullscreen();
    } catch {
      setNotice("暂时无法进入全屏，请重试。");
    }
  };
  const togglePip = async () => {
    const element = current();
    if (!(element instanceof HTMLVideoElement)) return;
    try {
      if (document.pictureInPictureElement === element) await document.exitPictureInPicture();
      else await element.requestPictureInPicture();
    } catch {
      setNotice("当前环境暂时无法打开画中画。");
    }
  };
  const keyboard = (event: KeyboardEvent<HTMLElement>) => {
    if (event.ctrlKey || event.metaKey || event.altKey || event.target !== event.currentTarget)
      return;
    switch (event.key.toLowerCase()) {
      case " ":
      case "k":
        void togglePlayback();
        break;
      case "arrowleft":
        seek(time - 5);
        break;
      case "arrowright":
        seek(time + 5);
        break;
      case "m":
        toggleMute();
        break;
      case "f":
        if (document.fullscreenEnabled) void toggleFullscreen();
        break;
      default:
        return;
    }
    event.preventDefault();
  };
  const action = playing || starting ? "暂停" : ended ? "重新播放" : "播放";
  const PlayIcon = playing || starting ? Pause : ended ? RotateCcw : Play;
  const progress = duration ? Math.min(100, (time / duration) * 100) : 0;
  const hasFullscreen =
    kind === "video" && typeof document !== "undefined" && document.fullscreenEnabled;
  const hasPip =
    kind === "video" && typeof document !== "undefined" && document.pictureInPictureEnabled;
  const pathToCopy = workspaceAudio ? (sourcePaths?.path ?? sourcePaths?.relativePath) : undefined;
  const optionsLabel = workspaceAudio
    ? zh
      ? "音频选项"
      : "Audio options"
    : workspaceVideo
      ? zh
        ? "视频选项"
        : "Video options"
      : "播放速度";
  if (error)
    return <PreviewUnavailable message={error} onDownload={onDownload} onRetry={onRetry} />;
  const play = (
    <Button
      variant="ghost"
      size="icon"
      className="za-media-play"
      tooltip={action}
      tooltipShortcut="Space"
      aria-label={action}
      onClick={() => void togglePlayback()}
    >
      <PlayIcon />
    </Button>
  );
  const volumeControl = (
    <Popover open={volumeOpen} onOpenChange={setVolumeOpen}>
      <PopoverTrigger
        render={
          <Button
            variant="ghost"
            size="icon"
            className="za-media-control"
            tooltip="音量"
            aria-label="音量"
          />
        }
      >
        {muted || !volume ? <VolumeX /> : <Volume2 />}
      </PopoverTrigger>
      <PopoverContent
        portalContainer={fullscreen ? container.current : undefined}
        side="top"
        className="za-media-volume-popup"
        aria-label="调节音量"
      >
        <Button
          variant="ghost"
          size="icon"
          className="za-media-control"
          tooltip={muted || !volume ? "取消静音" : "静音"}
          aria-label={muted || !volume ? "取消静音" : "静音"}
          onClick={toggleMute}
        >
          {muted || !volume ? <VolumeX /> : <Volume2 />}
        </Button>
        <input
          className="za-media-volume-range"
          type="range"
          min={0}
          max={1}
          step={0.01}
          value={muted ? 0 : volume}
          aria-label="音量大小"
          aria-valuetext={`${Math.round((muted ? 0 : volume) * 100)}%`}
          style={{ "--za-media-volume": `${(muted ? 0 : volume) * 100}%` } as CSSProperties}
          onChange={(event) => {
            const element = current();
            if (!element) return;
            element.volume = Number(event.target.value);
            element.muted = element.volume === 0;
          }}
        />
      </PopoverContent>
    </Popover>
  );
  const playbackOptions = (
    <DropdownMenu open={speedOpen} onOpenChange={setSpeedOpen}>
      <DropdownMenuTrigger
        render={
          <Button
            variant="ghost"
            size="sm"
            className="za-media-speed"
            tooltip={optionsLabel}
            aria-label={optionsLabel}
          />
        }
      >
        {workspaceTab ? <Ellipsis /> : `${rate}×`}
      </DropdownMenuTrigger>
      <DropdownMenuContent
        portalContainer={fullscreen ? container.current : undefined}
        side={workspaceAudio ? "bottom" : "top"}
        align="end"
        className="za-media-speed-menu"
      >
        {workspaceTab && (onDownload || pathToCopy) ? (
          <>
            {pathToCopy ? (
              <DropdownMenuItem
                onSelect={() => {
                  if (!current()) return;
                  void copyTextToClipboard(pathToCopy).then((copied) => {
                    if (!copied && !inactive)
                      setNotice(zh ? "无法复制文件路径。" : "Could not copy the file path.");
                  });
                }}
              >
                {zh ? "复制文件路径" : "Copy file path"}
              </DropdownMenuItem>
            ) : null}
            {onDownload ? (
              <DropdownMenuItem onSelect={onDownload}>
                {zh ? "保存原件" : "Save original"}
              </DropdownMenuItem>
            ) : null}
            <DropdownMenuSeparator />
          </>
        ) : null}
        {workspaceTab ? (
          <DropdownMenuLabel>{zh ? "播放速度" : "Playback speed"}</DropdownMenuLabel>
        ) : null}
        <DropdownMenuRadioGroup
          value={String(rate)}
          onValueChange={(value) => {
            const element = current();
            if (element) element.playbackRate = Number(value);
            setSpeedOpen(false);
          }}
        >
          {(workspaceVideo ? [0.25, ...rates] : rates).map((value) => (
            <DropdownMenuRadioItem key={value} value={String(value)}>
              {value === 1 ? "正常" : `${value}×`}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
        {hasPip && (compact || workspaceVideo) ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem disabled={!ready} onSelect={() => void togglePip()}>
              <PictureInPicture />
              {pip ? "退出画中画" : "画中画"}
            </DropdownMenuItem>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
  const format = name.match(/\.([a-z0-9]{1,8})$/i)?.[1]?.toUpperCase();
  const audioType = zh
    ? format
      ? `${format} 音频`
      : "音频"
    : format
      ? `${format} audio`
      : "Audio";
  const audioTitle = (
    <div className="za-media-audio-cover">
      <span className="za-media-audio-icon" aria-hidden="true">
        {workspaceAudio ? <AudioLines /> : <Headphones />}
      </span>
      {workspaceAudio ? (
        <>
          <div className="za-workspace-audio-identity">
            <h3 title={name}>{name}</h3>
            <span>
              {!ready
                ? zh
                  ? "正在加载音频…"
                  : "Loading audio…"
                : waiting
                  ? zh
                    ? "正在缓冲…"
                    : "Buffering…"
                  : audioType}
            </span>
          </div>
          <div className="za-workspace-audio-actions">
            {ready ? (
              play
            ) : onCancel ? (
              <Button variant="ghost" size="sm" onClick={onCancel}>
                {zh ? "取消" : "Cancel"}
              </Button>
            ) : null}
            {ready ? volumeControl : null}
            {playbackOptions}
          </div>
        </>
      ) : (
        <>
          <h3 title={name}>{name}</h3>
          <span>{playing ? "正在播放" : ended ? "播放完毕" : "音频"}</span>
        </>
      )}
    </div>
  );

  return (
    <TooltipPortalContainer.Provider value={fullscreen ? container.current : undefined}>
      <section
        ref={container}
        className="za-media-player"
        data-media-kind={kind}
        data-workspace-media={workspaceTab ? kind : undefined}
        data-playing={playing}
        aria-label={`${kind === "video" ? "视频" : "音频"}播放器：${name}`}
        // biome-ignore lint/a11y/noNoninteractiveTabindex: the named media region provides scoped playback and seek shortcuts, without capturing document keys.
        tabIndex={0}
        onKeyDown={keyboard}
        style={{ "--za-media-side-inset": `${fullscreen ? 0 : sideInset}px` } as CSSProperties}
      >
        <div className="za-media-canvas">
          {kind === "video" ? (
            /* biome-ignore lint/a11y/useMediaCaption: uploaded original has no caption track; do not invent one */
            <video
              ref={mediaRef}
              className="za-media-video"
              src={url}
              aria-label={workspaceVideo ? name : undefined}
              playsInline
              preload="auto"
              tabIndex={workspaceVideo ? 0 : -1}
              onClick={workspaceVideo ? () => void togglePlayback() : undefined}
              onKeyDown={workspaceVideo ? keyboard : undefined}
            />
          ) : (
            <>
              {/* biome-ignore lint/a11y/useMediaCaption: uploaded original has no caption track; do not invent one */}
              <audio ref={mediaRef} src={url} preload="metadata" />
              {workspaceAudio ? null : audioTitle}
            </>
          )}
          {!ready && !workspaceAudio ? (
            <div className="za-media-loading">
              <PreviewLoading message="正在加载媒体…" onCancel={onCancel} />
            </div>
          ) : null}
          {ready && waiting && !workspaceAudio ? (
            <span className="za-media-buffering" role="status">
              <span />
              正在缓冲
            </span>
          ) : null}
        </div>
        <div className="za-media-transport-area">
          {workspaceAudio ? audioTitle : null}
          {notice ? (
            <p className="za-media-notice" role="status">
              {notice}
            </p>
          ) : null}
          {(!workspaceAudio || ready) && (
            <PreviewDock className="za-media-transport" label="播放控制">
              {workspaceAudio ? null : play}
              <div className="za-media-seek">
                <div className="za-media-track" aria-hidden="true">
                  {buffered.map((range) => (
                    <span
                      key={`${range.start}:${range.end}`}
                      className="za-media-buffer"
                      style={{
                        left: `${duration ? (range.start / duration) * 100 : 0}%`,
                        width: `${duration ? ((range.end - range.start) / duration) * 100 : 0}%`,
                      }}
                    />
                  ))}
                  <span className="za-media-progress" style={{ width: `${progress}%` }} />
                </div>
                <input
                  className="za-media-range"
                  type="range"
                  min={0}
                  max={duration || 1}
                  step={workspaceAudio ? 0.1 : "any"}
                  value={time}
                  disabled={!duration}
                  aria-label="播放进度"
                  aria-valuetext={`${mediaTime(time)} / ${mediaTime(duration)}`}
                  onChange={(event) => seek(Number(event.target.value))}
                />
              </div>
              <span className="za-media-time" aria-live="off">
                {mediaTime(time)}
                <span> / {mediaTime(duration)}</span>
              </span>
              {workspaceAudio ? null : volumeControl}
              {workspaceAudio ? null : playbackOptions}
              {hasPip && !compact && !workspaceVideo ? (
                <Button
                  variant="ghost"
                  size="icon"
                  className="za-media-control za-media-pip"
                  tooltip={pip ? "退出画中画" : "画中画"}
                  aria-label={pip ? "退出画中画" : "画中画"}
                  disabled={!ready}
                  onClick={() => void togglePip()}
                >
                  <PictureInPicture />
                </Button>
              ) : null}
              {hasFullscreen ? (
                <Button
                  variant="ghost"
                  size="icon"
                  className="za-media-control"
                  tooltip={fullscreen ? "退出全屏" : "全屏播放"}
                  tooltipShortcut="F"
                  aria-label={fullscreen ? "退出全屏" : "全屏播放"}
                  onClick={() => void toggleFullscreen()}
                >
                  {fullscreen ? <Minimize /> : <Maximize />}
                </Button>
              ) : null}
            </PreviewDock>
          )}
        </div>
      </section>
    </TooltipPortalContainer.Provider>
  );
}
