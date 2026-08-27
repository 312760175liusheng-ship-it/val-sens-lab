'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

const TARGETS_PER_ROUND = 15;
const ROUND_SECONDS = 25;

type Stage = 'setup' | 'ready' | 'round' | 'rest' | 'result';
type Variant = 'low' | 'base' | 'high';
type InputMode = 'locked' | 'compat';

type Trial = {
  variant: Variant;
  sensitivity: number;
  multiplier: number;
};

type Target = { x: number; y: number; radius: number };

type MutableStats = {
  hits: number;
  misses: number;
  reactionTimes: number[];
  efficiencies: number[];
};

type RoundResult = {
  slot: string;
  variant: Variant;
  sensitivity: number;
  hits: number;
  misses: number;
  accuracy: number;
  averageReaction: number;
  control: number;
  score: number;
};

type LastRun = {
  dpi: number;
  baseSensitivity: number;
  recommended: number;
  confidence: string;
  date: string;
};

const emptyStats = (): MutableStats => ({ hits: 0, misses: 0, reactionTimes: [], efficiencies: [] });
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const formatSens = (value: number) => value.toFixed(3).replace(/0+$/, '').replace(/\.$/, '');

function shuffle<T>(items: T[]) {
  const copy = [...items];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    [copy[index], copy[swapIndex]] = [copy[swapIndex], copy[index]];
  }
  return copy;
}

function buildTrials(baseSensitivity: number): Trial[] {
  return shuffle([
    { variant: 'low' as const, sensitivity: clamp(baseSensitivity * 0.85, 0.01, 2), multiplier: 0.85 },
    { variant: 'base' as const, sensitivity: clamp(baseSensitivity, 0.01, 2), multiplier: 1 },
    { variant: 'high' as const, sensitivity: clamp(baseSensitivity * 1.15, 0.01, 2), multiplier: 1.15 },
  ]);
}

function makeResult(trial: Trial, slot: string, stats: MutableStats): RoundResult {
  const attempts = stats.hits + stats.misses;
  const accuracy = attempts ? stats.hits / attempts : 0;
  const averageReaction = stats.reactionTimes.length
    ? stats.reactionTimes.reduce((sum, value) => sum + value, 0) / stats.reactionTimes.length
    : 1500;
  const control = stats.efficiencies.length
    ? stats.efficiencies.reduce((sum, value) => sum + value, 0) / stats.efficiencies.length
    : 0;
  const speedScore = clamp((950 - averageReaction) / 5.5, 0, 100);
  const completionFactor = clamp(stats.hits / TARGETS_PER_ROUND, 0, 1);
  const score = (accuracy * 52 + (speedScore / 100) * 28 + control * 20) * completionFactor;

  return {
    slot,
    variant: trial.variant,
    sensitivity: trial.sensitivity,
    hits: stats.hits,
    misses: stats.misses,
    accuracy,
    averageReaction,
    control,
    score,
  };
}

function getVerdict(results: RoundResult[], baseSensitivity: number) {
  const ranked = [...results].sort((a, b) => b.score - a.score);
  const best = ranked[0];
  const gap = best && ranked[1] ? best.score - ranked[1].score : 0;
  const confidence = gap >= 7 ? '信号较强' : gap >= 3 ? '有轻微倾向' : '差异不足';
  const recommended = gap < 3 || !best ? baseSensitivity : best.sensitivity;
  const direction = gap < 3
    ? '三档差距太小，先保留当前设置。'
    : best.variant === 'low'
      ? '低档综合表现更稳，当前灵敏度可能偏快。'
      : best.variant === 'high'
        ? '高档综合表现更好，当前灵敏度可能偏慢。'
        : '当前档表现最好，不建议为了新鲜感改动。';

  return { best, gap, confidence, recommended, direction };
}

export default function Home() {
  const [stage, setStage] = useState<Stage>('setup');
  const [dpi, setDpi] = useState(800);
  const [baseSensitivity, setBaseSensitivity] = useState(0.35);
  const [trials, setTrials] = useState<Trial[]>([]);
  const [roundIndex, setRoundIndex] = useState(0);
  const [results, setResults] = useState<RoundResult[]>([]);
  const [timeLeft, setTimeLeft] = useState(ROUND_SECONDS);
  const [hud, setHud] = useState({ hits: 0, misses: 0 });
  const [cursor, setCursor] = useState({ x: 0, y: 0 });
  const [target, setTarget] = useState<Target>({ x: 0, y: 0, radius: 28 });
  const [paused, setPaused] = useState(false);
  const [pointerMessage, setPointerMessage] = useState('');
  const [inputMode, setInputMode] = useState<InputMode>('locked');
  const [compatUsed, setCompatUsed] = useState(false);
  const [lastRun, setLastRun] = useState<LastRun | null>(null);

  const arenaRef = useRef<HTMLDivElement>(null);
  const statsRef = useRef<MutableStats>(emptyStats());
  const stageRef = useRef<Stage>('setup');
  const pausedRef = useRef(false);
  const inputModeRef = useRef<InputMode>('locked');
  const cursorRef = useRef(cursor);
  const targetRef = useRef(target);
  const trialRef = useRef<Trial | undefined>(undefined);
  const targetSpawnRef = useRef(0);
  const targetStartRef = useRef({ x: 0, y: 0 });
  const pathTravelRef = useRef(0);
  const lastCursorRef = useRef({ x: 0, y: 0 });
  const resultsRef = useRef<RoundResult[]>([]);
  const finishingRef = useRef(false);
  const finishRoundRef = useRef<(stats?: MutableStats) => void>(() => undefined);

  const currentTrial = trials[roundIndex];
  const verdict = useMemo(() => getVerdict(results, baseSensitivity), [results, baseSensitivity]);
  const currentEDpi = Math.round(dpi * baseSensitivity);
  const cm360 = (360 * 2.54) / Math.max(1, dpi * baseSensitivity * 0.07);

  useEffect(() => {
    stageRef.current = stage;
    pausedRef.current = paused;
    inputModeRef.current = inputMode;
    cursorRef.current = cursor;
    targetRef.current = target;
    trialRef.current = currentTrial;
    resultsRef.current = results;
  }, [stage, paused, inputMode, cursor, target, currentTrial, results]);

  useEffect(() => {
    try {
      const stored = window.localStorage.getItem('val-sens-lab:last-run');
      if (stored) setLastRun(JSON.parse(stored) as LastRun);
    } catch {
      // Local history is optional; the test still works when storage is unavailable.
    }
  }, []);

  const spawnTarget = useCallback(() => {
    const arena = arenaRef.current;
    if (!arena) return;
    const { width, height } = arena.getBoundingClientRect();
    const radius = width < 700 ? 24 : 28;
    const padding = radius + 22;
    let next = { x: width / 2, y: height / 2, radius };

    for (let attempts = 0; attempts < 12; attempts += 1) {
      const candidate = {
        x: padding + Math.random() * Math.max(1, width - padding * 2),
        y: padding + 54 + Math.random() * Math.max(1, height - padding * 2 - 70),
        radius,
      };
      if (Math.hypot(candidate.x - cursorRef.current.x, candidate.y - cursorRef.current.y) > Math.min(240, width * 0.28)) {
        next = candidate;
        break;
      }
      next = candidate;
    }

    setTarget(next);
    targetRef.current = next;
    targetSpawnRef.current = performance.now();
    targetStartRef.current = { ...cursorRef.current };
    pathTravelRef.current = 0;
    lastCursorRef.current = { ...cursorRef.current };
  }, []);

  const finishRound = useCallback((providedStats?: MutableStats) => {
    if (finishingRef.current || !currentTrial) return;
    finishingRef.current = true;
    const finalStats = providedStats ?? statsRef.current;
    const result = makeResult(currentTrial, String.fromCharCode(65 + roundIndex), finalStats);
    const nextResults = [...resultsRef.current, result];
    resultsRef.current = nextResults;
    setResults(nextResults);
    if (document.pointerLockElement) document.exitPointerLock();
    setPaused(false);

    if (roundIndex >= trials.length - 1) {
      const finalVerdict = getVerdict(nextResults, baseSensitivity);
      const record: LastRun = {
        dpi,
        baseSensitivity,
        recommended: finalVerdict.recommended,
        confidence: finalVerdict.confidence,
        date: new Date().toLocaleDateString('zh-CN'),
      };
      try {
        window.localStorage.setItem('val-sens-lab:last-run', JSON.stringify(record));
        setLastRun(record);
      } catch {
        // Ignore storage failures.
      }
      setStage('result');
    } else {
      setStage('rest');
    }
  }, [baseSensitivity, currentTrial, dpi, roundIndex, trials.length]);

  useEffect(() => {
    finishRoundRef.current = finishRound;
  }, [finishRound]);

  useEffect(() => {
    if (stage !== 'round' || paused) return;
    const interval = window.setInterval(() => setTimeLeft((value) => Math.max(0, value - 1)), 1000);
    return () => window.clearInterval(interval);
  }, [stage, paused]);

  useEffect(() => {
    if (stage === 'round' && timeLeft === 0) finishRoundRef.current();
  }, [stage, timeLeft]);

  useEffect(() => {
    const onPointerLockChange = () => {
      if (stageRef.current !== 'round' || inputModeRef.current !== 'locked') return;
      const locked = document.pointerLockElement === arenaRef.current;
      setPaused(!locked);
      pausedRef.current = !locked;
    };
    document.addEventListener('pointerlockchange', onPointerLockChange);
    return () => {
      document.removeEventListener('pointerlockchange', onPointerLockChange);
    };
  }, []);

  useEffect(() => {
    const onMouseMove = (event: MouseEvent) => {
      if (stageRef.current !== 'round' || pausedRef.current) return;
      const arena = arenaRef.current;
      if (!arena) return;
      const bounds = arena.getBoundingClientRect();
      const isLocked = inputModeRef.current === 'locked' && document.pointerLockElement === arena;
      const isInsideArena = event.clientX >= bounds.left && event.clientX <= bounds.right
        && event.clientY >= bounds.top && event.clientY <= bounds.bottom;
      const isCompatible = inputModeRef.current === 'compat' && isInsideArena;
      if (!isLocked && !isCompatible) return;
      const { width, height } = bounds;
      const multiplier = trialRef.current?.multiplier ?? 1;
      const next = {
        x: clamp(cursorRef.current.x + event.movementX * multiplier, 0, width),
        y: clamp(cursorRef.current.y + event.movementY * multiplier, 0, height),
      };
      pathTravelRef.current += Math.hypot(next.x - lastCursorRef.current.x, next.y - lastCursorRef.current.y);
      lastCursorRef.current = next;
      cursorRef.current = next;
      setCursor(next);
    };

    const onMouseDown = (event: MouseEvent) => {
      const arena = arenaRef.current;
      if (event.button !== 0 || stageRef.current !== 'round' || pausedRef.current || !arena) return;
      const bounds = arena.getBoundingClientRect();
      const isLocked = inputModeRef.current === 'locked' && document.pointerLockElement === arena;
      const isInsideArena = event.clientX >= bounds.left && event.clientX <= bounds.right
        && event.clientY >= bounds.top && event.clientY <= bounds.bottom;
      if (!isLocked && !(inputModeRef.current === 'compat' && isInsideArena)) return;
      const currentTarget = targetRef.current;
      const distance = Math.hypot(cursorRef.current.x - currentTarget.x, cursorRef.current.y - currentTarget.y);
      const updated: MutableStats = {
        hits: statsRef.current.hits,
        misses: statsRef.current.misses,
        reactionTimes: [...statsRef.current.reactionTimes],
        efficiencies: [...statsRef.current.efficiencies],
      };

      if (distance <= currentTarget.radius) {
        updated.hits += 1;
        updated.reactionTimes.push(performance.now() - targetSpawnRef.current);
        const straightDistance = Math.hypot(
          currentTarget.x - targetStartRef.current.x,
          currentTarget.y - targetStartRef.current.y,
        );
        updated.efficiencies.push(clamp(straightDistance / Math.max(straightDistance, pathTravelRef.current), 0, 1));
        statsRef.current = updated;
        setHud({ hits: updated.hits, misses: updated.misses });
        if (updated.hits >= TARGETS_PER_ROUND) finishRoundRef.current(updated);
        else spawnTarget();
      } else {
        updated.misses += 1;
        statsRef.current = updated;
        setHud({ hits: updated.hits, misses: updated.misses });
      }
    };

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mousedown', onMouseDown);
    return () => {
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mousedown', onMouseDown);
    };
  }, [spawnTarget]);

  const attemptPointerLock = (arena: HTMLDivElement, options?: { unadjustedMovement?: boolean }) => new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (locked: boolean) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeout);
      document.removeEventListener('pointerlockchange', onChange);
      document.removeEventListener('pointerlockerror', onError);
      resolve(locked);
    };
    const onChange = () => finish(document.pointerLockElement === arena);
    const onError = () => finish(false);
    const timeout = window.setTimeout(() => finish(document.pointerLockElement === arena), 700);
    document.addEventListener('pointerlockchange', onChange);
    document.addEventListener('pointerlockerror', onError);

    try {
      const request = arena.requestPointerLock.bind(arena) as (lockOptions?: { unadjustedMovement?: boolean }) => Promise<void> | void;
      const result = request(options);
      if (result && typeof result.catch === 'function') result.catch(() => finish(false));
    } catch {
      finish(false);
    }
  });

  const enableCompatibilityMode = () => {
    inputModeRef.current = 'compat';
    setInputMode('compat');
    setCompatUsed(true);
    setPointerMessage('已切换兼容模式：无需锁定鼠标，但结果更容易受系统鼠标加速和窗口边缘影响。');
    pausedRef.current = false;
    setPaused(false);
    if (document.pointerLockElement) document.exitPointerLock();
  };

  const requestLock = async () => {
    const arena = arenaRef.current;
    if (!arena) return;
    inputModeRef.current = 'locked';
    setInputMode('locked');
    pausedRef.current = true;
    setPaused(true);

    const rawLocked = await attemptPointerLock(arena, { unadjustedMovement: true });
    const locked = rawLocked || await attemptPointerLock(arena);
    if (locked) {
      setPointerMessage('');
      pausedRef.current = false;
      setPaused(false);
    } else {
      enableCompatibilityMode();
    }
  };

  const beginRound = async () => {
    const arena = arenaRef.current;
    if (!arena) return;
    const { width, height } = arena.getBoundingClientRect();
    const center = { x: width / 2, y: height / 2 };
    statsRef.current = emptyStats();
    setHud({ hits: 0, misses: 0 });
    setTimeLeft(ROUND_SECONDS);
    cursorRef.current = center;
    setCursor(center);
    finishingRef.current = false;
    setPaused(true);
    setStage('round');
    stageRef.current = 'round';
    await requestLock();
    window.setTimeout(spawnTarget, 80);
  };

  const startTest = () => {
    const safeDpi = clamp(Number.isFinite(dpi) ? dpi : 800, 100, 6400);
    const safeSensitivity = clamp(Number.isFinite(baseSensitivity) ? baseSensitivity : 0.35, 0.01, 2);
    setDpi(safeDpi);
    setBaseSensitivity(safeSensitivity);
    setTrials(buildTrials(safeSensitivity));
    setRoundIndex(0);
    setResults([]);
    resultsRef.current = [];
    setInputMode('locked');
    inputModeRef.current = 'locked';
    setCompatUsed(false);
    setStage('ready');
  };

  const nextRound = () => {
    setRoundIndex((value) => value + 1);
    setStage('ready');
  };

  const reset = () => {
    if (document.pointerLockElement) document.exitPointerLock();
    setStage('setup');
    setResults([]);
    setTrials([]);
    setInputMode('locked');
    inputModeRef.current = 'locked';
    setCompatUsed(false);
  };

  if (stage === 'setup') {
    return (
      <main className="min-h-screen bg-[#080b0f] px-5 py-6 text-[#f4f7f8] sm:px-8 lg:px-12">
        <TopBar />
        <section className="mx-auto grid max-w-6xl gap-10 py-12 lg:grid-cols-[0.9fr_1.1fr] lg:items-center lg:py-20">
          <div>
            <p className="mb-5 text-xs font-bold tracking-[0.24em] text-[#ff4655]">01 / 建立基准</p>
            <h1 className="max-w-xl text-4xl font-black leading-[1.08] tracking-tight sm:text-6xl">
              别凭手感乱改，<span className="text-[#65f5c6]">用对照测试找灵敏度。</span>
            </h1>
            <p className="mt-6 max-w-xl text-sm leading-7 text-white/55 sm:text-base">
              同一套目标，随机测试低、当前、高三档灵敏度。工具记录命中率、反应时间和移动效率，再给出主推荐与微调方向。
            </p>
            <div className="mt-8 grid max-w-lg grid-cols-3 gap-3 text-xs text-white/45">
              {['盲测三档', '每轮 25 秒', '本地出结论'].map((item, index) => (
                <div key={item} className="border-l border-white/15 pl-3">
                  <strong className="mb-1 block text-base text-white">0{index + 1}</strong>{item}
                </div>
              ))}
            </div>
            <div className="mt-8 max-w-xl rounded-2xl border border-amber-300/15 bg-amber-300/5 px-4 py-3 text-xs leading-6 text-amber-100/55">
              这个网页只能比较“相对快慢”，不能完全复刻游戏引擎。一次结果只当起点，第二天复测一致再改。
            </div>
          </div>

          <div className="relative overflow-hidden rounded-[28px] border border-white/10 bg-[#10151b] p-5 shadow-2xl shadow-black/40 sm:p-8">
            <div className="pointer-events-none absolute -right-24 -top-24 h-64 w-64 rounded-full bg-[#ff4655]/10 blur-3xl" />
            <div className="relative">
              <div className="mb-7 flex items-center justify-between gap-4">
                <div>
                  <p className="text-xs font-bold tracking-[0.2em] text-white/35">你的当前设置</p>
                  <p className="mt-1 text-lg font-bold">先告诉我起点</p>
                </div>
                <span className="font-mono text-xs text-white/35">eDPI {currentEDpi}</span>
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                <label className="rounded-2xl border border-white/10 bg-black/20 p-4 focus-within:border-[#65f5c6]/50">
                  <span className="text-xs text-white/45">鼠标 DPI</span>
                  <input aria-label="鼠标 DPI" className="mt-2 w-full bg-transparent font-mono text-3xl font-bold outline-none" min="100" max="6400" step="50" type="number" value={dpi} onChange={(event) => setDpi(Number(event.target.value))} />
                  <span className="mt-3 flex gap-2">
                    {[400, 800, 1600].map((value) => (
                      <button className={`rounded-md px-2 py-1 text-[10px] ${dpi === value ? 'bg-white/15 text-white' : 'bg-white/5 text-white/35'}`} key={value} onClick={() => setDpi(value)} type="button">{value}</button>
                    ))}
                  </span>
                </label>
                <label className="rounded-2xl border border-white/10 bg-black/20 p-4 focus-within:border-[#65f5c6]/50">
                  <span className="text-xs text-white/45">游戏内灵敏度</span>
                  <input aria-label="游戏内灵敏度" className="mt-2 w-full bg-transparent font-mono text-3xl font-bold outline-none" min="0.01" max="2" step="0.001" type="number" value={baseSensitivity} onChange={(event) => setBaseSensitivity(Number(event.target.value))} />
                  <span className="mt-4 block text-[10px] text-white/25">允许范围 0.01–2.00</span>
                </label>
              </div>

              <div className="mt-4 grid grid-cols-2 gap-2 rounded-2xl border border-[#65f5c6]/15 bg-[#65f5c6]/5 px-4 py-3 text-xs">
                <span className="text-white/45">约 {cm360.toFixed(1)} cm / 360°</span>
                <span className="text-right text-[#65f5c6]">候选 ±15%</span>
              </div>

              {lastRun && (
                <div className="mt-4 flex items-center justify-between rounded-xl border border-white/8 px-4 py-3 text-[11px] text-white/35">
                  <span>上次 {lastRun.date} · {lastRun.confidence}</span>
                  <span className="font-mono text-white/60">建议 {formatSens(lastRun.recommended)}</span>
                </div>
              )}

              <button className="mt-6 w-full rounded-2xl bg-[#ff4655] px-5 py-4 text-sm font-black tracking-[0.12em] text-white shadow-lg shadow-[#ff4655]/15 transition hover:-translate-y-0.5 hover:bg-[#ff5d69]" onClick={startTest} type="button">
                开始三轮盲测 →
              </button>
              <p className="mt-4 text-center text-[11px] leading-5 text-white/30">需要桌面电脑和鼠标；保持同一坐姿与握法。</p>
            </div>
          </div>
        </section>
      </main>
    );
  }

  if (stage === 'result') {
    return (
      <main className="min-h-screen bg-[#080b0f] px-5 py-6 text-[#f4f7f8] sm:px-8 lg:px-12">
        <TopBar />
        <section className="mx-auto max-w-6xl py-10 sm:py-14">
          <div className="flex flex-col justify-between gap-5 lg:flex-row lg:items-end">
            <div>
              <p className="text-xs font-bold tracking-[0.24em] text-[#65f5c6]">03 / 测试结论</p>
              <h1 className="mt-3 text-4xl font-black sm:text-5xl">建议灵敏度 <span className="text-[#ff4655]">{formatSens(verdict.recommended)}</span></h1>
              <p className="mt-4 text-sm text-white/50">{verdict.direction} · {verdict.confidence}</p>
              {compatUsed && <p className="mt-3 text-xs leading-6 text-amber-200/60">本次使用了兼容模式，结论置信度自动降低一级；建议在 Chrome 或 Edge 中再复测一次。</p>}
            </div>
            <div className="grid grid-cols-2 gap-3 font-mono text-sm">
              <Metric label="建议 eDPI" value={Math.round(dpi * verdict.recommended)} />
              <Metric label="约 cm / 360°" value={((360 * 2.54) / Math.max(1, dpi * verdict.recommended * 0.07)).toFixed(1)} />
            </div>
          </div>

          <div className="mt-10 grid gap-4 lg:grid-cols-3">
            {results.map((result) => {
              const isBest = verdict.best?.slot === result.slot;
              return (
                <article className={`rounded-3xl border p-5 ${isBest ? 'border-[#65f5c6]/50 bg-[#65f5c6]/8' : 'border-white/10 bg-[#10151b]'}`} key={result.slot}>
                  <div className="flex items-start justify-between">
                    <div>
                      <p className="text-xs tracking-[0.2em] text-white/35">方案 {result.slot}</p>
                      <p className="mt-1 font-mono text-3xl font-bold">{formatSens(result.sensitivity)}</p>
                    </div>
                    <span className={`rounded-full px-3 py-1 text-[10px] ${isBest ? 'bg-[#65f5c6] text-black' : 'bg-white/5 text-white/35'}`}>{isBest ? '本次最佳' : '对照档'}</span>
                  </div>
                  <div className="mt-6 grid grid-cols-3 gap-2 border-t border-white/10 pt-5">
                    <ResultMetric label="命中率" value={`${Math.round(result.accuracy * 100)}%`} />
                    <ResultMetric label="平均反应" value={`${Math.round(result.averageReaction)}ms`} />
                    <ResultMetric label="移动效率" value={`${Math.round(result.control * 100)}%`} />
                  </div>
                  <div className="mt-5 flex items-end justify-between">
                    <span className="text-[11px] text-white/30">综合分</span>
                    <strong className="font-mono text-2xl">{result.score.toFixed(1)}</strong>
                  </div>
                </article>
              );
            })}
          </div>

          <div className="mt-6 grid gap-4 lg:grid-cols-[1.2fr_0.8fr]">
            <div className="rounded-3xl border border-white/10 bg-[#10151b] p-6">
              <p className="text-sm font-bold">怎么使用这个结论</p>
              <ol className="mt-4 grid gap-3 text-xs leading-6 text-white/50 sm:grid-cols-3">
                <li><span className="mr-2 text-[#ff4655]">01</span>只改灵敏度，不同时换 DPI、鼠标垫或握法。</li>
                <li><span className="mr-2 text-[#ff4655]">02</span>进靶场打 10 分钟，再打 2 局普通模式。</li>
                <li><span className="mr-2 text-[#ff4655]">03</span>第二天复测方向一致，再把它固定一周。</li>
              </ol>
            </div>
            <div className="rounded-3xl border border-amber-300/15 bg-amber-300/5 p-6 text-xs leading-6 text-amber-100/55">
              若出现 A/D 丢键、D 键卡住或眼睛不适，本次结果直接作废，先停止。灵敏度测试不能诊断输入故障，也不能替代游戏内实战验证。
            </div>
          </div>

          <div className="mt-8 flex flex-col gap-3 sm:flex-row">
            <button className="rounded-2xl bg-[#ff4655] px-6 py-4 text-sm font-black" onClick={startTest} type="button">用同一设置再测一次</button>
            <button className="rounded-2xl border border-white/10 px-6 py-4 text-sm text-white/60" onClick={reset} type="button">修改起始设置</button>
          </div>
        </section>
      </main>
    );
  }

  const completedResult = results[results.length - 1];

  return (
    <main className="min-h-screen select-none bg-[#080b0f] px-3 py-3 text-[#f4f7f8] sm:px-5 sm:py-5">
      <div className="mx-auto flex max-w-[1500px] items-center justify-between gap-3 px-2 pb-3">
        <div className="flex items-center gap-3">
          <span className="grid h-8 w-8 place-items-center rounded-lg bg-[#ff4655] text-sm font-black">V</span>
          <div>
            <p className="text-xs font-black tracking-[0.16em]">VAL SENS LAB</p>
            <p className="text-[9px] text-white/30">盲测方案 {String.fromCharCode(65 + roundIndex)} / 共 3 轮</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {[0, 1, 2].map((index) => <span className={`h-1.5 w-10 rounded-full ${index < roundIndex ? 'bg-[#65f5c6]' : index === roundIndex ? 'bg-[#ff4655]' : 'bg-white/10'}`} key={index} />)}
        </div>
        <button className="text-xs text-white/35 hover:text-white" onClick={reset} type="button">退出测试</button>
      </div>

      <div
        aria-label="灵敏度点击测试区域"
        className={`aim-grid relative mx-auto h-[calc(100vh-76px)] min-h-[520px] max-w-[1500px] overflow-hidden rounded-3xl border border-white/10 bg-[#0d1218] ${stage === 'round' ? 'cursor-none' : ''}`}
        ref={arenaRef}
      >
        <div className="absolute inset-x-0 top-0 z-20 flex items-center justify-center gap-5 border-b border-white/8 bg-[#0a0e13]/85 px-4 py-3 font-mono text-xs backdrop-blur">
          <span><em className="not-italic text-white/30">命中</em> {hud.hits}/{TARGETS_PER_ROUND}</span>
          <span><em className="not-italic text-white/30">失误</em> {hud.misses}</span>
          <span><em className="not-italic text-white/30">剩余</em> {timeLeft}s</span>
          {inputMode === 'compat' && <span className="rounded-full bg-amber-300/10 px-2 py-1 text-[9px] text-amber-200/70">兼容模式</span>}
        </div>

        {stage === 'round' && !paused && (
          <>
            <div className="aim-target" style={{ left: target.x, top: target.y, width: target.radius * 2, height: target.radius * 2 }} />
            <div className="virtual-reticle" style={{ left: cursor.x, top: cursor.y }} />
            <p className="pointer-events-none absolute bottom-4 left-1/2 w-full -translate-x-1/2 text-center text-[10px] tracking-[0.12em] text-white/25">
              {inputMode === 'compat' ? '兼容模式 · 鼠标保持在黑色测试区内 · 左键命中目标' : 'ESC 暂停 · 左键命中红色目标'}
            </p>
          </>
        )}

        {stage === 'ready' && (
          <ArenaOverlay eyebrow={`方案 ${String.fromCharCode(65 + roundIndex)} · 不显示倍率`} title={roundIndex === 0 ? '先做一轮熟悉手感' : '保持同样坐姿，继续下一轮'} body="点击后会优先锁定鼠标；若当前浏览器不支持，将自动进入可点击的兼容模式。移动绿色准星，左键击中 15 个红色目标。">
            <button className="rounded-2xl bg-[#ff4655] px-7 py-4 text-sm font-black tracking-[0.1em]" onClick={beginRound} type="button">锁定鼠标并开始</button>
          </ArenaOverlay>
        )}

        {stage === 'round' && paused && (
          <ArenaOverlay eyebrow="测试已暂停" title="鼠标锁定已解除" body={pointerMessage || '测试计时已经暂停。点击继续后会重新锁定鼠标，当前成绩不会丢失。'}>
            <div className="flex flex-col justify-center gap-3 sm:flex-row">
              <button className="rounded-2xl bg-[#ff4655] px-7 py-4 text-sm font-black" onClick={requestLock} type="button">重新锁定并继续</button>
              <button className="rounded-2xl border border-white/15 px-7 py-4 text-sm text-white/70" onClick={enableCompatibilityMode} type="button">兼容模式继续</button>
            </div>
          </ArenaOverlay>
        )}

        {stage === 'rest' && completedResult && (
          <ArenaOverlay eyebrow={`方案 ${completedResult.slot} 完成`} title={`${completedResult.hits} 次命中 · ${completedResult.misses} 次失误`} body="先松手休息 10–20 秒。为了保持盲测，三档具体数值会在全部完成后一起揭晓。">
            <button className="rounded-2xl bg-[#65f5c6] px-7 py-4 text-sm font-black text-black" onClick={nextRound} type="button">进入下一轮</button>
          </ArenaOverlay>
        )}
      </div>
    </main>
  );
}

function TopBar() {
  return (
    <nav className="mx-auto flex max-w-6xl items-center justify-between border-b border-white/10 pb-5">
      <div className="flex items-center gap-3">
        <span className="grid h-9 w-9 place-items-center rounded-lg bg-[#ff4655] font-black text-white">V</span>
        <div>
          <p className="text-sm font-black tracking-[0.18em]">VAL SENS LAB</p>
          <p className="text-[10px] tracking-[0.18em] text-white/40">灵敏度对照实验</p>
        </div>
      </div>
      <span className="rounded-full border border-[#65f5c6]/25 bg-[#65f5c6]/5 px-3 py-1 text-[11px] text-[#65f5c6]">本地记录 · 无需登录</span>
    </nav>
  );
}

function ArenaOverlay({ eyebrow, title, body, children }: { eyebrow: string; title: string; body: string; children: React.ReactNode }) {
  return (
    <div className="absolute inset-0 z-30 grid place-items-center bg-[#080b0f]/80 p-5 backdrop-blur-sm">
      <div className="max-w-lg text-center">
        <p className="text-xs font-bold tracking-[0.24em] text-[#65f5c6]">{eyebrow}</p>
        <h1 className="mt-4 text-3xl font-black sm:text-5xl">{title}</h1>
        <p className="mx-auto mt-5 max-w-md text-sm leading-7 text-white/50">{body}</p>
        <div className="mt-8">{children}</div>
      </div>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string | number }) {
  return <div className="rounded-2xl border border-white/10 bg-[#10151b] px-5 py-3"><span className="block text-[10px] text-white/30">{label}</span><strong className="mt-1 block text-lg">{value}</strong></div>;
}

function ResultMetric({ label, value }: { label: string; value: string }) {
  return <div><span className="block text-[9px] text-white/30">{label}</span><strong className="mt-1 block font-mono text-sm">{value}</strong></div>;
}
