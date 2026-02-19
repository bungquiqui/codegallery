import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { RAW_POSTCODE_CSV } from './data/postcodes';
import { PostcodeData } from './types';
import { GoogleGenAI } from "@google/genai";

// Controls the sensitivity of the scroll
const BASE_STEP_HEIGHT = 15; 
const MAX_VIRTUAL_SCROLL_PX = 8_000_000;
const MIN_VIRTUAL_CYCLES = 120;
const SNAP_IMAGE_HOLD_THRESHOLD = 7;
const PASSWORD_STORAGE_KEY = 'auspost_gallery_auth_v1';
const SITE_PASSWORD =
  (typeof import.meta !== 'undefined' && import.meta.env?.VITE_SITE_PASSWORD) ||
  'passcode';

type Orientation = 'landscape' | 'portrait';

type IndexedImage = {
  url: string;
  postcode: string;
  orientation: Orientation;
  normalizedName: string;
};

const IMAGE_MODULES = import.meta.glob(
  './image/postcode-images/**/*.{jpg,jpeg,png,JPG,JPEG,PNG}',
  { eager: true, import: 'default' }
) as Record<string, string>;

const normalizeForMatch = (value: string) =>
  value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');

const IMAGE_INDEX: IndexedImage[] = Object.entries(IMAGE_MODULES)
  .map(([modulePath, url]) => {
    const fileName = modulePath.split('/').pop() || '';
    const baseName = fileName.replace(/\.[^.]+$/, '');
    const postcodeMatch = baseName.match(/^(\d{3,4})/);

    if (!postcodeMatch) {
      return null;
    }

    return {
      url,
      postcode: postcodeMatch[1].padStart(4, '0'),
      orientation: modulePath.includes('/portrait/') ? 'portrait' : 'landscape',
      normalizedName: normalizeForMatch(baseName),
    } satisfies IndexedImage;
  })
  .filter((entry): entry is IndexedImage => entry !== null);

const resolvePostcodeImage = (
  postcode: string,
  suburb: string,
  orientation: Orientation
) => {
  const suburbToken = normalizeForMatch(suburb);
  const exactOrientation = IMAGE_INDEX.filter(
    (entry) => entry.postcode === postcode && entry.orientation === orientation
  );
  const pool = exactOrientation;

  if (pool.length === 0) {
    return null;
  }

  const expected = [
    `${postcode}_${suburbToken}_${orientation}`,
    `${postcode}_${suburbToken}`,
    `${postcode}_${orientation}`,
    `${postcode}`,
  ];

  let best = pool[0];
  let bestScore = -1;

  for (const entry of pool) {
    let score = entry.orientation === orientation ? 5 : 0;

    for (let i = 0; i < expected.length; i++) {
      const token = expected[i];
      if (!token || token.endsWith('_')) continue;

      if (entry.normalizedName === token) {
        score = Math.max(score, 100 - i * 10);
      } else if (entry.normalizedName.startsWith(token)) {
        score = Math.max(score, 80 - i * 8);
      } else if (suburbToken && entry.normalizedName.includes(suburbToken)) {
        score = Math.max(score, 45 - i * 2);
      }
    }

    if (score > bestScore) {
      bestScore = score;
      best = entry;
    }
  }

  return best.url;
};

const toTitleCase = (str: string) => {
  if (!str) return "";
  return str.toLowerCase().split(' ').map(word => 
    word.charAt(0).toUpperCase() + word.slice(1)
  ).join(' ');
};

const useOrientation = () => {
  const [orientation, setOrientation] = useState<Orientation>(
    typeof window !== 'undefined' && window.innerHeight > window.innerWidth ? 'portrait' : 'landscape'
  );

  useEffect(() => {
    const handleResize = () => {
      setOrientation(window.innerHeight > window.innerWidth ? 'portrait' : 'landscape');
    };
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  return orientation;
};

const BackgroundFrame: React.FC<{ 
  visible: boolean; 
  imageUrl: string | null;
  preloadUrls: string[];
  altColorMode: boolean;
  stackMode: boolean;
}> = ({
  visible,
  imageUrl,
  preloadUrls,
  altColorMode,
  stackMode,
}) => {
  const [lastImageUrl, setLastImageUrl] = useState<string | null>(null);
  const [activeImageUrl, setActiveImageUrl] = useState<string | null>(null);

  useEffect(() => {
    if (imageUrl) {
      setLastImageUrl(imageUrl);
    }
  }, [imageUrl]);

  const displayImageUrl = stackMode ? (imageUrl || lastImageUrl) : imageUrl;

  useEffect(() => {
    if (!displayImageUrl) return;
    setActiveImageUrl(displayImageUrl);
  }, [displayImageUrl]);

  return (
    <div className={`absolute inset-0 transition-opacity duration-250 ease-out z-0 ${altColorMode ? 'bg-white' : 'bg-[#dc1928]'} ${visible ? 'opacity-100' : 'opacity-0'}`}>
      {/* Main Image */}
      <div
        className="absolute inset-0 z-10"
      >
        {activeImageUrl ? (
          <img
            src={activeImageUrl}
            alt=""
            className="h-full w-full object-cover select-none pointer-events-none"
            draggable={false}
          />
        ) : null}
      </div>
      {/* Hidden preload stack to keep nearby images warm in the browser cache */}
      {stackMode &&
        preloadUrls.map((url, idx) => (
          <img
            key={`${url}-${idx}`}
            src={url}
            alt=""
            className="absolute inset-0 h-full w-full object-cover opacity-0 pointer-events-none select-none"
            style={{ zIndex: idx }}
            draggable={false}
          />
        ))}
      {/* Theme overlay */}
      <div className="absolute inset-0 bg-transparent" />
    </div>
  );
};

const App: React.FC = () => {
  const orientation = useOrientation();
  
  // Initialize Gemini configuration
  useEffect(() => {
    try {
      // Use GEMINI_API_KEY from .env.local via vite define config
      const apiKey =
        typeof process !== 'undefined'
          ? (process.env.GEMINI_API_KEY || process.env.API_KEY)
          : undefined;

      if (apiKey) {
        new GoogleGenAI({ apiKey });
        console.log("Gemini Instance initialized successfully.");
      } else {
        // Silent fail for local demo mode if no key is provided
        console.log("GEMINI_API_KEY not found. App running in local image mode.");
      }
    } catch (error) {
      console.error("Failed to initialize Gemini:", error);
    }
  }, []);
  
  const POSTCODES = useMemo(() => {
    const lines = RAW_POSTCODE_CSV.split('\n');
    const data: PostcodeData[] = [];
    for (const line of lines) {
      const trimmedLine = line.trim();
      if (!trimmedLine || trimmedLine.toLowerCase().startsWith('postcode')) continue;
      
      const parts = trimmedLine.split(',').map(p => p.trim().replace(/^"|"$/g, ''));
      if (parts.length >= 3) {
        data.push({ 
          postcode: parts[0].padStart(4, '0'), 
          suburb: parts[1], 
          state: parts[2] 
        });
      }
    }
    return data;
  }, []);

  const initialIndexRef = useRef<number>(
    POSTCODES.length > 0 ? Math.floor(Math.random() * POSTCODES.length) : 0
  );
  const hasInitializedScrollRef = useRef(false);
  const [activeIndex, setActiveIndex] = useState(initialIndexRef.current);
  const [isLanded, setIsLanded] = useState(false);
  const [isAltColorMode, setIsAltColorMode] = useState(false);
  const [isAltScrollMode, setIsAltScrollMode] = useState(true);
  const [isImagesMode, setIsImagesMode] = useState(false);
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [passwordInput, setPasswordInput] = useState('');
  const [authError, setAuthError] = useState('');
  
  const scrollRef = useRef<HTMLDivElement>(null);
  const sidebarRef = useRef<HTMLDivElement>(null);
  const activeIndexRef = useRef(activeIndex);
  const inputBuffer = useRef<string>("");
  const inputTimeout = useRef<any>(null); // Type as any or ReturnType<typeof setTimeout>
  const stopTimeout = useRef<any>(null);
  const altScrollLockRef = useRef(false);
  const snapWheelGestureLockRef = useRef(false);
  const snapWheelGestureTimeoutRef = useRef<any>(null);
  const snapImageHoldUntilRef = useRef(0);

  const LIST_LENGTH = POSTCODES.length;
  const LIST_PIXEL_HEIGHT = LIST_LENGTH * BASE_STEP_HEIGHT;
  const VIRTUAL_MULTIPLIER = useMemo(() => {
    if (LIST_PIXEL_HEIGHT <= 0) return MIN_VIRTUAL_CYCLES;
    return Math.max(
      MIN_VIRTUAL_CYCLES,
      Math.floor(MAX_VIRTUAL_SCROLL_PX / LIST_PIXEL_HEIGHT)
    );
  }, [LIST_PIXEL_HEIGHT]);
  const TOTAL_VIRTUAL_HEIGHT = LIST_PIXEL_HEIGHT * VIRTUAL_MULTIPLIER;

  const UNIQUE_POSTCODES = useMemo(() => {
    const seen = new Set<string>();
    const unique: Array<PostcodeData & { firstIndex: number }> = [];

    POSTCODES.forEach((entry, index) => {
      if (!seen.has(entry.postcode)) {
        seen.add(entry.postcode);
        unique.push({ ...entry, firstIndex: index });
      }
    });

    return unique;
  }, [POSTCODES]);

  const POSTCODE_FIRST_INDEX = useMemo(() => {
    const map = new Map<string, number>();
    POSTCODES.forEach((entry, index) => {
      if (!map.has(entry.postcode)) {
        map.set(entry.postcode, index);
      }
    });
    return map;
  }, [POSTCODES]);

  const ORIENTATION_IMAGE_POSTCODES = useMemo(() => {
    return new Set(
      IMAGE_INDEX.filter((entry) => entry.orientation === orientation).map(
        (entry) => entry.postcode
      )
    );
  }, [orientation]);

  const ANY_IMAGE_POSTCODES = useMemo(() => {
    return new Set(IMAGE_INDEX.map((entry) => entry.postcode));
  }, []);

  const RESOLVED_IMAGE_URLS = useMemo(
    () =>
      POSTCODES.map((entry) =>
        resolvePostcodeImage(entry.postcode, entry.suburb, orientation)
      ),
    [POSTCODES, orientation]
  );

  const IMAGE_ENTRY_INDICES = useMemo(
    () =>
      RESOLVED_IMAGE_URLS.map((url, index) => ({ url, index }))
        .filter((item): item is { url: string; index: number } => Boolean(item.url))
        .map((item) => item.index),
    [RESOLVED_IMAGE_URLS]
  );

  const IMAGE_ENTRY_INDEX_SET = useMemo(
    () => new Set(IMAGE_ENTRY_INDICES),
    [IMAGE_ENTRY_INDICES]
  );

  const findNearestImageIndex = useCallback(
    (fromIndex: number) => {
      if (IMAGE_ENTRY_INDICES.length === 0 || LIST_LENGTH === 0) return null;
      let nearest = IMAGE_ENTRY_INDICES[0];
      let minDistance = Number.POSITIVE_INFINITY;
      const normalizedFrom = ((fromIndex % LIST_LENGTH) + LIST_LENGTH) % LIST_LENGTH;
      for (const candidate of IMAGE_ENTRY_INDICES) {
        const rawDistance = Math.abs(candidate - normalizedFrom);
        const circularDistance = Math.min(rawDistance, LIST_LENGTH - rawDistance);
        if (circularDistance < minDistance) {
          minDistance = circularDistance;
          nearest = candidate;
        }
      }
      return nearest;
    },
    [IMAGE_ENTRY_INDICES, LIST_LENGTH]
  );

  const STACK_MODE_PRELOAD_URLS = useMemo(() => {
    const stackMode = isImagesMode || isAltScrollMode;
    if (!stackMode || IMAGE_ENTRY_INDICES.length === 0) return [] as string[];
    const currentImageIdx = findNearestImageIndex(activeIndex);
    if (currentImageIdx === null) return [] as string[];
    const pointer = IMAGE_ENTRY_INDICES.findIndex((idx) => idx === currentImageIdx);
    if (pointer === -1) return [] as string[];

    const urls: string[] = [];
    for (let step = 1; step <= 4; step++) {
      const nextPointer = (pointer + step) % IMAGE_ENTRY_INDICES.length;
      const prevPointer =
        (pointer - step + IMAGE_ENTRY_INDICES.length) % IMAGE_ENTRY_INDICES.length;
      const nextUrl = RESOLVED_IMAGE_URLS[IMAGE_ENTRY_INDICES[nextPointer]];
      const prevUrl = RESOLVED_IMAGE_URLS[IMAGE_ENTRY_INDICES[prevPointer]];
      if (nextUrl) urls.push(nextUrl);
      if (prevUrl) urls.push(prevUrl);
    }
    return Array.from(new Set(urls));
  }, [activeIndex, IMAGE_ENTRY_INDICES, isAltScrollMode, isImagesMode, RESOLVED_IMAGE_URLS, findNearestImageIndex]);

  const scrollToIndex = useCallback((targetIndex: number, behavior: ScrollBehavior = 'auto') => {
    if (!scrollRef.current || LIST_LENGTH === 0) return;
    const normalizedIndex =
      ((targetIndex % LIST_LENGTH) + LIST_LENGTH) % LIST_LENGTH;
    const currentScroll = scrollRef.current.scrollTop;
    const cycleStart =
      Math.floor(currentScroll / LIST_PIXEL_HEIGHT) * LIST_PIXEL_HEIGHT;
    const nextTop = cycleStart + normalizedIndex * BASE_STEP_HEIGHT;
    scrollRef.current.scrollTo({ top: nextTop, behavior });
    setActiveIndex(normalizedIndex);
    setIsLanded(isImagesMode);
  }, [LIST_LENGTH, LIST_PIXEL_HEIGHT, isImagesMode]);

  const jumpToPostcode = useCallback(
    (postcode: string) => {
      const foundIdx = POSTCODE_FIRST_INDEX.get(postcode);
      if (foundIdx === undefined) return;
      if (isImagesMode) {
        if (IMAGE_ENTRY_INDEX_SET.has(foundIdx)) {
          scrollToIndex(foundIdx, 'smooth');
          return;
        }
        const nearestImage = findNearestImageIndex(foundIdx);
        if (nearestImage !== null) {
          scrollToIndex(nearestImage, 'smooth');
        }
        return;
      }
      scrollToIndex(foundIdx, 'smooth');
    },
    [POSTCODE_FIRST_INDEX, scrollToIndex, isImagesMode, IMAGE_ENTRY_INDEX_SET, findNearestImageIndex]
  );

  const findNextImageIndex = useCallback(
    (fromIndex: number, direction: 1 | -1) => {
      if (IMAGE_ENTRY_INDICES.length === 0 || LIST_LENGTH === 0) {
        return null;
      }

      const normalizedFrom = ((fromIndex % LIST_LENGTH) + LIST_LENGTH) % LIST_LENGTH;
      if (direction > 0) {
        for (const idx of IMAGE_ENTRY_INDICES) {
          if (idx > normalizedFrom) return idx;
        }
        return IMAGE_ENTRY_INDICES[0];
      }

      for (let i = IMAGE_ENTRY_INDICES.length - 1; i >= 0; i--) {
        if (IMAGE_ENTRY_INDICES[i] < normalizedFrom) return IMAGE_ENTRY_INDICES[i];
      }
      return IMAGE_ENTRY_INDICES[IMAGE_ENTRY_INDICES.length - 1];
    },
    [IMAGE_ENTRY_INDICES, LIST_LENGTH]
  );

  const scrollToDirectionalImage = useCallback(
    (targetIndex: number, direction: 1 | -1, behavior: ScrollBehavior) => {
      if (!scrollRef.current || LIST_LENGTH === 0) return;
      const currentTop = scrollRef.current.scrollTop;
      const cycleStart = Math.floor(currentTop / LIST_PIXEL_HEIGHT) * LIST_PIXEL_HEIGHT;
      let nextTop = cycleStart + targetIndex * BASE_STEP_HEIGHT;

      if (direction > 0 && nextTop <= currentTop) {
        nextTop += LIST_PIXEL_HEIGHT;
      }
      if (direction < 0 && nextTop >= currentTop) {
        nextTop -= LIST_PIXEL_HEIGHT;
      }

      scrollRef.current.scrollTo({ top: nextTop, behavior });
      setActiveIndex(targetIndex);
    },
    [LIST_LENGTH, LIST_PIXEL_HEIGHT]
  );

  const stepToImage = useCallback(
    (direction: 1 | -1) => {
      const currentIndex = activeIndexRef.current;
      const nextImageIndex = findNextImageIndex(currentIndex, direction);
      if (nextImageIndex === null) return;

      const distance =
        direction > 0
          ? nextImageIndex > currentIndex
            ? nextImageIndex - currentIndex
            : LIST_LENGTH - currentIndex + nextImageIndex
          : nextImageIndex < currentIndex
            ? currentIndex - nextImageIndex
            : currentIndex + (LIST_LENGTH - nextImageIndex);
      const keepImageShellInSnap =
        isAltScrollMode &&
        !isImagesMode &&
        distance <= SNAP_IMAGE_HOLD_THRESHOLD;

      altScrollLockRef.current = true;
      if (keepImageShellInSnap) {
        snapImageHoldUntilRef.current = Date.now() + 260;
        setIsLanded(true);
        scrollToDirectionalImage(nextImageIndex, direction, 'auto');
      } else {
        setIsLanded(isImagesMode);
        scrollToDirectionalImage(
          nextImageIndex,
          direction,
          isImagesMode ? 'auto' : 'smooth'
        );
      }
      window.setTimeout(() => {
        altScrollLockRef.current = false;
      }, keepImageShellInSnap ? 120 : isImagesMode ? 120 : 160);
    },
    [LIST_LENGTH, findNextImageIndex, isAltScrollMode, isImagesMode, scrollToDirectionalImage]
  );

  const forwardWheelToMain = useCallback(
    (event: React.WheelEvent<HTMLDivElement>) => {
      if (!scrollRef.current) return;
      event.preventDefault();
      const useImageStepMode = isAltScrollMode || isImagesMode;
      if (useImageStepMode) {
        if (isAltScrollMode) {
          if (snapWheelGestureLockRef.current) return;
          if (event.deltaY === 0) return;
          snapWheelGestureLockRef.current = true;
          if (snapWheelGestureTimeoutRef.current) {
            clearTimeout(snapWheelGestureTimeoutRef.current);
          }
          snapWheelGestureTimeoutRef.current = setTimeout(() => {
            snapWheelGestureLockRef.current = false;
          }, 220);
        }
        if (altScrollLockRef.current) return;
        if (event.deltaY === 0) return;
        const direction: 1 | -1 = event.deltaY > 0 ? 1 : -1;
        stepToImage(direction);
        return;
      }

      scrollRef.current.scrollTop += event.deltaY;
    },
    [isAltScrollMode, isImagesMode, stepToImage]
  );

  useEffect(() => {
    return () => {
      if (snapWheelGestureTimeoutRef.current) {
        clearTimeout(snapWheelGestureTimeoutRef.current);
      }
    };
  }, []);

  // Initialize random position once on mount
  useEffect(() => {
    if (hasInitializedScrollRef.current) return;
    if (scrollRef.current && LIST_LENGTH > 0) {
      const randomIndex = initialIndexRef.current % LIST_LENGTH;
      const middleCycle = Math.floor(VIRTUAL_MULTIPLIER / 2) * LIST_PIXEL_HEIGHT;
      scrollRef.current.scrollTop = middleCycle + (randomIndex * BASE_STEP_HEIGHT);
      setActiveIndex(randomIndex);
      hasInitializedScrollRef.current = true;
    }
  }, [LIST_LENGTH, LIST_PIXEL_HEIGHT]);

  useEffect(() => {
    // Prefetch nearby resolved image URLs to reduce perceived latency on landing.
    if (LIST_LENGTH === 0) return;
    const preloadOffsets = [-6, -5, -4, -3, -2, -1, 1, 2, 3, 4, 5, 6];
    for (const offset of preloadOffsets) {
      const idx = ((activeIndex + offset) % LIST_LENGTH + LIST_LENGTH) % LIST_LENGTH;
      const url = RESOLVED_IMAGE_URLS[idx];
      if (!url) continue;
      const img = new Image();
      img.src = url;
    }
  }, [LIST_LENGTH, RESOLVED_IMAGE_URLS, activeIndex]);

  useEffect(() => {
    activeIndexRef.current = activeIndex;
  }, [activeIndex]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const saved = window.sessionStorage.getItem(PASSWORD_STORAGE_KEY);
    if (saved === 'ok') {
      setIsAuthenticated(true);
    }
  }, []);

  const handleUnlock = useCallback(
    (e: React.FormEvent<HTMLFormElement>) => {
      e.preventDefault();
      if (passwordInput === SITE_PASSWORD) {
        setIsAuthenticated(true);
        setAuthError('');
        if (typeof window !== 'undefined') {
          window.sessionStorage.setItem(PASSWORD_STORAGE_KEY, 'ok');
        }
        return;
      }
      setAuthError('Incorrect password');
    },
    [passwordInput]
  );

  useEffect(() => {
    if (!isImagesMode) return;
    const nearest = findNearestImageIndex(activeIndex);
    if (nearest === null) return;
    if (nearest !== activeIndex) {
      scrollToIndex(nearest, 'auto');
    }
    setIsLanded(true);
  }, [isImagesMode, activeIndex, findNearestImageIndex, scrollToIndex]);

  // Handle virtual scrolling
  const handleScroll = useCallback(() => {
    if (!scrollRef.current || LIST_LENGTH === 0) return;
    let scrollTop = scrollRef.current.scrollTop;
    const normalizedOffset =
      ((scrollTop % LIST_PIXEL_HEIGHT) + LIST_PIXEL_HEIGHT) % LIST_PIXEL_HEIGHT;

    // Keep the scroll anchor near the middle while preserving the visible index.
    if (
      scrollTop < LIST_PIXEL_HEIGHT * 1.5 ||
      scrollTop > TOTAL_VIRTUAL_HEIGHT - LIST_PIXEL_HEIGHT * 1.5
    ) {
      const middleCycleTop =
        Math.floor(VIRTUAL_MULTIPLIER / 2) * LIST_PIXEL_HEIGHT;
      scrollRef.current.scrollTop = middleCycleTop + normalizedOffset;
      scrollTop = scrollRef.current.scrollTop;
    }

    const rawIndex = Math.floor(
      (((scrollTop % LIST_PIXEL_HEIGHT) + LIST_PIXEL_HEIGHT) % LIST_PIXEL_HEIGHT) /
        BASE_STEP_HEIGHT
    );
    const imageOnlyTracking = isImagesMode;
    const index =
      imageOnlyTracking ? (findNearestImageIndex(rawIndex) ?? rawIndex) : rawIndex;

    if (index !== activeIndex) {
      setActiveIndex(index);
      if (!imageOnlyTracking) {
        const shouldHoldImageShell =
          isAltScrollMode && Date.now() < snapImageHoldUntilRef.current;
        if (!shouldHoldImageShell) {
          setIsLanded(false);
        }
      }
    }

    // Detect stop and only enter landed mode when an image exists for this orientation.
    if (stopTimeout.current) clearTimeout(stopTimeout.current);
    const stopDelay = isAltScrollMode ? 120 : 180;
    stopTimeout.current = setTimeout(() => {
      if (
        isImagesMode ||
        (isAltScrollMode && Date.now() < snapImageHoldUntilRef.current)
      ) {
        setIsLanded(true);
        return;
      }
      setIsLanded(IMAGE_ENTRY_INDEX_SET.has(index));
    }, stopDelay);
  }, [
    activeIndex,
    LIST_LENGTH,
    LIST_PIXEL_HEIGHT,
    TOTAL_VIRTUAL_HEIGHT,
    IMAGE_ENTRY_INDEX_SET,
    findNearestImageIndex,
    isAltScrollMode,
    isImagesMode,
  ]);

  // Handle keyboard input (Type to jump)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((isAltScrollMode || isImagesMode) && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
        e.preventDefault();
        stepToImage(e.key === 'ArrowDown' ? 1 : -1);
        return;
      }

      if (/^\d$/.test(e.key)) {
        inputBuffer.current += e.key;
        if (inputTimeout.current) clearTimeout(inputTimeout.current);
        inputTimeout.current = setTimeout(() => { inputBuffer.current = ""; }, 1500);

        if (inputBuffer.current.length === 4) {
          const target = inputBuffer.current;
          jumpToPostcode(target);
          inputBuffer.current = "";
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [jumpToPostcode, isAltScrollMode, isImagesMode, stepToImage]);

  useEffect(() => {
    const sidebar = sidebarRef.current;
    if (!sidebar || LIST_LENGTH === 0) return;
    const activePostcode = POSTCODES[activeIndex]?.postcode;
    if (!activePostcode) return;

    const activeRow = sidebar.querySelector<HTMLButtonElement>(
      `[data-postcode="${activePostcode}"]`
    );
    if (!activeRow) return;
    const targetTop =
      activeRow.offsetTop + activeRow.offsetHeight / 2 - sidebar.clientHeight / 2;
    const maxTop = Math.max(0, sidebar.scrollHeight - sidebar.clientHeight);
    sidebar.scrollTop = Math.min(maxTop, Math.max(0, targetTop));
  }, [POSTCODES, activeIndex, LIST_LENGTH]);

  if (POSTCODES.length === 0) return null;

  if (!isAuthenticated) {
    return (
      <div
        className="h-screen w-screen flex items-center justify-center bg-[#dc1928] text-white px-6"
        style={{ fontFamily: "'APTypeProDisplay', sans-serif", fontWeight: 700 }}
      >
        <form
          onSubmit={handleUnlock}
          className="w-full max-w-sm flex flex-col items-stretch gap-4"
        >
          <div className="text-3xl tracking-[0.02em] text-center">Enter Password</div>
          <input
            type="password"
            value={passwordInput}
            onChange={(e) => setPasswordInput(e.target.value)}
            className="h-12 px-4 bg-transparent border border-white/60 outline-none text-white placeholder:text-white/60"
            placeholder="Password"
            autoFocus
          />
          <button
            type="submit"
            className="h-12 border border-white text-white hover:bg-white hover:text-[#dc1928] transition-colors"
          >
            Unlock
          </button>
          {authError ? (
            <div className="text-center text-sm text-white/90">{authError}</div>
          ) : null}
        </form>
      </div>
    );
  }

  const activeItem = POSTCODES[activeIndex];

  return (
    <div
      className={`relative h-screen w-screen overflow-hidden select-none ${isAltColorMode ? 'bg-white' : 'bg-[#dc1928]'}`}
      style={{ fontFamily: "'APTypeProDisplay', sans-serif", fontWeight: 700 }}
      onWheel={forwardWheelToMain}
    >
      <div
        className={`absolute top-4 right-4 z-[80] flex gap-3 text-xs tracking-wider ${
          isAltColorMode && !isLanded ? 'text-gray-500' : 'text-white'
        }`}
      >
        <span
          role="button"
          tabIndex={0}
          onClick={() => setIsAltColorMode((v) => !v)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              setIsAltColorMode((v) => !v);
            }
          }}
          className={`cursor-pointer select-none ${isAltColorMode ? 'opacity-100 underline' : 'opacity-70 hover:opacity-100'}`}
        >
          Light
        </span>
        <span
          role="button"
          tabIndex={0}
          onClick={() => setIsAltScrollMode(false)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              setIsAltScrollMode(false);
            }
          }}
          className={`cursor-pointer select-none ${!isAltScrollMode ? 'opacity-100 underline' : 'opacity-70 hover:opacity-100'}`}
        >
          Scroll
        </span>
        <span
          role="button"
          tabIndex={0}
          onClick={() => setIsAltScrollMode(true)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              setIsAltScrollMode(true);
            }
          }}
          className={`cursor-pointer select-none ${isAltScrollMode ? 'opacity-100 underline' : 'opacity-70 hover:opacity-100'}`}
        >
          Snap
        </span>
        <span
          role="button"
          tabIndex={0}
          onClick={() => setIsImagesMode((v) => !v)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              setIsImagesMode((v) => !v);
            }
          }}
          className={`cursor-pointer select-none ${isImagesMode ? 'opacity-100 underline' : 'opacity-70 hover:opacity-100'}`}
        >
          Images
        </span>
      </div>

      {!isImagesMode && (
      <aside className="absolute left-0 top-0 bottom-0 z-[60] w-12">
        <div className="pointer-events-none absolute left-0 right-0 top-1/2 -translate-y-1/2 flex items-center justify-center">
          <span className={`h-4 w-4 rounded-full border ${isAltColorMode ? 'border-[#212129]/60' : 'border-white/60'}`} />
        </div>
        <div ref={sidebarRef} className="h-full overflow-y-hidden py-2">
          {UNIQUE_POSTCODES.map((entry) => {
            const isActive = entry.postcode === activeItem.postcode;
            const hasOrientation = ORIENTATION_IMAGE_POSTCODES.has(entry.postcode);
            const hasAnyImage = ANY_IMAGE_POSTCODES.has(entry.postcode);
            const dotClass =
              isAltColorMode && !isLanded
                ? hasOrientation
                  ? 'bg-gray-400'
                  : hasAnyImage
                    ? 'bg-gray-300'
                    : 'bg-gray-200'
                : hasOrientation
                  ? 'bg-white'
                  : hasAnyImage
                    ? 'bg-amber-300'
                    : 'bg-white/25';

            return (
              <button
                key={entry.postcode}
                type="button"
                data-postcode={entry.postcode}
                onClick={() => scrollToIndex(entry.firstIndex)}
                aria-label={`${entry.postcode} ${toTitleCase(entry.suburb)}`}
                className="w-full py-1.5 flex items-center justify-center"
              >
                <span
                  className={`h-2.5 w-2.5 rounded-full ${dotClass} ${
                    isActive ? 'opacity-100' : 'opacity-80'
                  }`}
                />
              </button>
            );
          })}
        </div>
      </aside>
      )}
      
      {/* BACKGROUND LAYER */}
      <BackgroundFrame 
        visible={isLanded} 
        imageUrl={RESOLVED_IMAGE_URLS[activeIndex] || null}
        preloadUrls={STACK_MODE_PRELOAD_URLS}
        altColorMode={isAltColorMode}
        stackMode={isImagesMode || isAltScrollMode}
      />

      {/* CENTER TYPOGRAPHY (SCROLLING STATE) */}
      <div className={`fixed inset-0 flex flex-col items-center justify-center transition-all duration-180 pointer-events-none z-10 ${isLanded ? 'opacity-0 scale-95' : 'opacity-100 scale-100'}`}>
        <div className={`text-[15vh] md:text-[25vh] font-bold leading-none tracking-tighter ${isAltColorMode ? 'text-[#212129]' : 'text-white'}`}>
          {activeItem.postcode.split('').map((digit, i) => (
            <span key={i} className="inline-block w-[0.6em] text-center">{digit}</span>
          ))}
        </div>
        <div className="mt-8 flex flex-col items-center text-center px-6">
          <div className={`text-2xl md:text-3xl tracking-[0.015em] font-bold max-w-2xl leading-tight ${isAltColorMode ? 'text-[#212129]' : 'text-white'}`}>
            {toTitleCase(activeItem.suburb)},
            <span className="font-bold"> {activeItem.state.toUpperCase()}</span>
          </div>
        </div>
      </div>

      {/* FOOTER TEXT (LANDED STATE) */}
      <div className={`fixed bottom-0 left-0 right-0 p-10 flex items-center justify-center transition-all duration-120 z-30 pointer-events-none ${isLanded ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-4'}`}>
        <div className="flex flex-col md:flex-row items-center md:items-baseline gap-2 md:gap-8 text-4xl md:text-5xl font-bold tracking-[0.015em] text-center text-white">
          <span>{activeItem.postcode}</span>
          <span className="font-bold">{toTitleCase(activeItem.suburb)}, {activeItem.state.toUpperCase()}</span>
        </div>
      </div>

      {/* SCROLL CAPTURE LAYER (INVISIBLE) */}
      <div 
        ref={scrollRef}
        className="scroll-master h-full w-full overflow-y-scroll absolute inset-0 z-50 cursor-ns-resize opacity-0"
        onScroll={handleScroll}
      >
        <div 
          className="scroll-height w-px" 
          style={{ height: `${TOTAL_VIRTUAL_HEIGHT}px` }}
        />
      </div>

    </div>
  );
};

export default App;
