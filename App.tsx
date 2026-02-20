import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { RAW_POSTCODE_CSV } from './data/postcodes';
import { PostcodeData } from './types';
import apLogoWhite from './image/logos/ap-logo-white.svg';
import apLogoRed from './image/logos/ap-logo-red.svg';

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

const useViewport = () => {
  const [viewport, setViewport] = useState(() => ({
    width:
      typeof window !== 'undefined'
        ? Math.round(window.visualViewport?.width || window.innerWidth)
        : 1024,
    height:
      typeof window !== 'undefined'
        ? Math.round(window.visualViewport?.height || window.innerHeight)
        : 768,
  }));

  useEffect(() => {
    const handleResize = () => {
      setViewport({
        width: Math.round(window.visualViewport?.width || window.innerWidth),
        height: Math.round(window.visualViewport?.height || window.innerHeight),
      });
    };
    window.addEventListener('resize', handleResize);
    window.visualViewport?.addEventListener('resize', handleResize);
    window.visualViewport?.addEventListener('scroll', handleResize);
    return () => {
      window.removeEventListener('resize', handleResize);
      window.visualViewport?.removeEventListener('resize', handleResize);
      window.visualViewport?.removeEventListener('scroll', handleResize);
    };
  }, []);

  return viewport;
};

const BackgroundFrame: React.FC<{ 
  visible: boolean; 
  imageUrl: string | null;
  imageIndex: number;
  preloadUrls: string[];
  altColorMode: boolean;
  stackMode: boolean;
  mobileContain: boolean;
  onRenderedImageIndexChange?: (index: number) => void;
}> = ({
  visible,
  imageUrl,
  imageIndex,
  preloadUrls,
  altColorMode,
  stackMode,
  mobileContain,
  onRenderedImageIndexChange,
}) => {
  const [renderedImageUrl, setRenderedImageUrl] = useState<string | null>(null);
  const [renderedImageIndex, setRenderedImageIndex] = useState<number | null>(null);
  const [previousImageUrl, setPreviousImageUrl] = useState<string | null>(null);
  const loadTicketRef = useRef(0);
  const loadedUrlsRef = useRef<Set<string>>(new Set());
  const previousImageClearTimeoutRef = useRef<number | null>(null);

  useEffect(() => {
    const nextUrl = stackMode ? (imageUrl || renderedImageUrl) : imageUrl;
    if (!nextUrl) return;
    if (nextUrl === renderedImageUrl && renderedImageIndex === imageIndex) return;

    const commit = () => {
      if (renderedImageUrl && renderedImageUrl !== nextUrl) {
        setPreviousImageUrl(renderedImageUrl);
        if (previousImageClearTimeoutRef.current !== null) {
          window.clearTimeout(previousImageClearTimeoutRef.current);
        }
        previousImageClearTimeoutRef.current = window.setTimeout(() => {
          setPreviousImageUrl(null);
          previousImageClearTimeoutRef.current = null;
        }, 220);
      }
      setRenderedImageUrl(nextUrl);
      setRenderedImageIndex(imageIndex);
      loadedUrlsRef.current.add(nextUrl);
    };

    if (loadedUrlsRef.current.has(nextUrl)) {
      commit();
      return;
    }

    const ticket = ++loadTicketRef.current;
    const preloader = new Image();
    let cancelled = false;
    preloader.decoding = 'async';
    preloader.src = nextUrl;

    const finish = () => {
      if (cancelled) return;
      if (loadTicketRef.current !== ticket) return;
      commit();
    };

    preloader.onload = finish;
    preloader.onerror = finish;
    if (preloader.complete) {
      finish();
    }

    return () => {
      cancelled = true;
    };
  }, [imageUrl, imageIndex, renderedImageUrl, renderedImageIndex, stackMode]);

  useEffect(() => {
    return () => {
      if (previousImageClearTimeoutRef.current !== null) {
        window.clearTimeout(previousImageClearTimeoutRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (renderedImageIndex === null) return;
    onRenderedImageIndexChange?.(renderedImageIndex);
  }, [renderedImageIndex, onRenderedImageIndexChange]);

  return (
    <div className={`absolute inset-0 transition-opacity duration-250 ease-out z-0 ${(mobileContain || stackMode) ? 'bg-black' : altColorMode ? 'bg-white' : 'bg-[#dc1928]'} ${visible ? 'opacity-100' : 'opacity-0'}`}>
      {/* Previous image layer retained briefly to avoid fallback flashes during swaps */}
      {previousImageUrl && previousImageUrl !== renderedImageUrl ? (
        <img
          src={previousImageUrl}
          alt=""
          className={`absolute inset-0 z-10 h-full w-full select-none pointer-events-none ${mobileContain ? 'object-contain object-center' : 'object-cover object-center'}`}
          decoding="async"
          loading="eager"
          draggable={false}
        />
      ) : null}
      {/* Main image layer */}
      {renderedImageUrl ? (
        <img
          src={renderedImageUrl}
          alt=""
          className={`absolute inset-0 z-20 h-full w-full select-none pointer-events-none ${mobileContain ? 'object-contain object-center' : 'object-cover object-center'}`}
          decoding="async"
          loading="eager"
          fetchPriority="high"
          onLoad={() => loadedUrlsRef.current.add(renderedImageUrl)}
          draggable={false}
        />
      ) : null}
      {/* Hidden preload stack to keep nearby images warm in the browser cache */}
      {stackMode &&
        preloadUrls.map((url, idx) => (
          <img
            key={`${url}-${idx}`}
            src={url}
            alt=""
            className={`absolute inset-0 h-full w-full opacity-0 pointer-events-none select-none ${mobileContain ? 'object-contain' : 'object-cover'}`}
            style={{ zIndex: idx }}
            decoding="async"
            loading="eager"
            onLoad={() => loadedUrlsRef.current.add(url)}
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
  const viewport = useViewport();

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
  const [landedImageIndex, setLandedImageIndex] = useState(initialIndexRef.current);
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
  const sidebarAlignTimeoutRef = useRef<any>(null);
  const snapFinalizeTimeoutRef = useRef<any>(null);
  const [sidebarViewportHeight, setSidebarViewportHeight] = useState(0);
  const snapTargetIndexRef = useRef<number | null>(null);
  const snapAnimRafRef = useRef<number | null>(null);
  const altScrollLockRef = useRef(false);
  const snapWheelGestureLockRef = useRef(false);
  const snapWheelGestureTimeoutRef = useRef<any>(null);
  const desktopWheelDeltaRef = useRef(0);
  const desktopWheelResetTimeoutRef = useRef<any>(null);
  const snapImageHoldUntilRef = useRef(0);
  const touchStartYRef = useRef<number | null>(null);
  const touchStepTriggeredRef = useRef(false);

  const LIST_LENGTH = POSTCODES.length;
  const useImageStepMode = isAltScrollMode || isImagesMode;
  const isMobileViewport = viewport.width < 768;
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

  const RESOLVED_IMAGE_URLS = useMemo(
    () =>
      POSTCODES.map((entry) =>
        resolvePostcodeImage(entry.postcode, entry.suburb, orientation)
      ),
    [POSTCODES, orientation]
  );

  const RESOLVED_IMAGE_POSTCODES = useMemo(() => {
    const set = new Set<string>();
    POSTCODES.forEach((entry, index) => {
      if (RESOLVED_IMAGE_URLS[index]) {
        set.add(entry.postcode);
      }
    });
    return set;
  }, [POSTCODES, RESOLVED_IMAGE_URLS]);

  const ANY_IMAGE_POSTCODES = useMemo(() => {
    return new Set(IMAGE_INDEX.map((entry) => entry.postcode));
  }, []);

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
  const activeImageUrl = RESOLVED_IMAGE_URLS[activeIndex] || null;
  const handleRenderedImageIndexChange = useCallback((index: number) => {
    setLandedImageIndex(index);
  }, []);

  const mobileImageFrame = useMemo(() => {
    const fullFrame = {
      top: 0,
      bottom: 0,
      left: 0,
      right: 0,
      width: viewport.width,
      height: viewport.height,
    };
    if (!isMobileViewport) return fullFrame;
    const frameWidth = viewport.width;
    const frameHeight = Math.min(viewport.height, viewport.width * (16 / 9));
    const top = Math.max(0, (viewport.height - frameHeight) / 2);
    const bottom = Math.max(0, viewport.height - top - frameHeight);
    const left = 0;
    const right = 0;
    return { top, bottom, left, right, width: frameWidth, height: frameHeight };
  }, [isMobileViewport, viewport.height, viewport.width]);

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

  const getDirectionalTargetTop = useCallback(
    (targetIndex: number, direction: 1 | -1, currentTop: number) => {
      const cycleStart = Math.floor(currentTop / LIST_PIXEL_HEIGHT) * LIST_PIXEL_HEIGHT;
      let nextTop = cycleStart + targetIndex * BASE_STEP_HEIGHT;

      if (direction > 0 && nextTop <= currentTop) {
        nextTop += LIST_PIXEL_HEIGHT;
      }
      if (direction < 0 && nextTop >= currentTop) {
        nextTop -= LIST_PIXEL_HEIGHT;
      }

      return nextTop;
    },
    [LIST_PIXEL_HEIGHT]
  );

  const scrollToDirectionalImage = useCallback(
    (targetIndex: number, direction: 1 | -1, behavior: ScrollBehavior) => {
      if (!scrollRef.current || LIST_LENGTH === 0) return;
      const currentTop = scrollRef.current.scrollTop;
      const nextTop = getDirectionalTargetTop(targetIndex, direction, currentTop);
      scrollRef.current.scrollTo({ top: nextTop, behavior });
      setActiveIndex(targetIndex);
    },
    [LIST_LENGTH, getDirectionalTargetTop]
  );

  const animateToDirectionalImage = useCallback(
    (
      targetIndex: number,
      direction: 1 | -1,
      durationMs: number,
      distanceUnits: number
    ) => {
      if (!scrollRef.current || LIST_LENGTH === 0) return;
      const startTop = scrollRef.current.scrollTop;
      const targetTop = getDirectionalTargetTop(targetIndex, direction, startTop);
      if (Math.abs(targetTop - startTop) < 0.5) {
        setActiveIndex(targetIndex);
        return;
      }

      if (snapAnimRafRef.current !== null) {
        cancelAnimationFrame(snapAnimRafRef.current);
      }

      const startTs = performance.now();
      const distance = targetTop - startTop;
      const distanceFactor = Math.min(
        1,
        Math.max(0, (distanceUnits - 8) / 40)
      );
      const earlyEaseExponent = 1.08 + distanceFactor * 0.32;
      const haltPower = 3.2 + distanceFactor * 3.4;

      const step = (ts: number) => {
        if (!scrollRef.current) return;
        const t = Math.min(1, (ts - startTs) / Math.max(1, durationMs));
        // Distance-aware easing: longer jumps get a longer, heavier "grind to halt" tail.
        const earlyEase = Math.pow(t, earlyEaseExponent);
        const eased = 1 - Math.pow(1 - earlyEase, haltPower);
        scrollRef.current.scrollTop = startTop + distance * eased;
        (window as any).__postcodeEaseDebug = {
          ...(window as any).__postcodeEaseDebug,
          branch: 'snap-ease-animation',
          animProgress: t,
          animEased: eased,
          animEarlyEase: earlyEase,
          animEaseExponent: earlyEaseExponent,
          animHaltPower: haltPower,
          animDistanceFactor: distanceFactor,
          animDurationMs: durationMs,
          animDistancePx: distance,
          animDistanceUnits: distanceUnits,
        };

        if (t < 1) {
          snapAnimRafRef.current = requestAnimationFrame(step);
          return;
        }

        scrollRef.current.scrollTop = targetTop;
        setActiveIndex(targetIndex);
        snapAnimRafRef.current = null;
      };

      snapAnimRafRef.current = requestAnimationFrame(step);
    },
    [LIST_LENGTH, getDirectionalTargetTop]
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
      const gestureSettleMs = isMobileViewport
        ? Math.min(220, Math.max(110, distance * 4))
        : (() => {
            // Desktop: longer jumps should feel deliberate and visibly grind to a halt.
            const base = 720;
            const distanceScale = distance < 10 ? distance * 22 : distance * 38;
            const longJumpBoost = Math.pow(Math.max(0, distance - 8), 1.15) * 6;
            const scaled = base + distanceScale + longJumpBoost;
            return Math.min(3200, Math.max(720, scaled));
          })();

      altScrollLockRef.current = true;
      if (isAltScrollMode && !isImagesMode) {
        snapTargetIndexRef.current = nextImageIndex;
      }
      if (keepImageShellInSnap) {
        snapImageHoldUntilRef.current = Date.now() + 260;
        setIsLanded(true);
        scrollToDirectionalImage(nextImageIndex, direction, 'auto');
      } else {
        setIsLanded(isImagesMode);
        if (isAltScrollMode && !isImagesMode && !isMobileViewport) {
          animateToDirectionalImage(
            nextImageIndex,
            direction,
            gestureSettleMs,
            distance
          );
        } else {
          scrollToDirectionalImage(
            nextImageIndex,
            direction,
            isImagesMode ? 'auto' : 'smooth'
          );
        }
        if (isAltScrollMode && !isImagesMode) {
          if (snapFinalizeTimeoutRef.current) {
            clearTimeout(snapFinalizeTimeoutRef.current);
          }
          snapFinalizeTimeoutRef.current = setTimeout(() => {
            scrollToIndex(nextImageIndex, 'auto');
            setIsLanded(true);
          }, gestureSettleMs);
        }
      }
      window.setTimeout(() => {
        altScrollLockRef.current = false;
      }, keepImageShellInSnap ? 120 : isImagesMode ? 120 : gestureSettleMs);
    },
    [
      LIST_LENGTH,
      findNextImageIndex,
      isAltScrollMode,
      isImagesMode,
      isMobileViewport,
      animateToDirectionalImage,
      scrollToDirectionalImage,
      scrollToIndex,
    ]
  );

  const forwardWheelToMain = useCallback(
    (event: React.WheelEvent<HTMLDivElement>) => {
      if (!scrollRef.current) return;
      if (event.cancelable) {
        event.preventDefault();
      }
      (window as any).__postcodeEaseDebug = {
        ...(window as any).__postcodeEaseDebug,
        status: 'wheel',
        mode: isImagesMode ? 'images' : isAltScrollMode ? 'snap' : 'scroll',
        wheelDelta: event.deltaY,
        ts: Date.now(),
      };
      if (useImageStepMode) {
        if (isAltScrollMode) {
          if (event.deltaY === 0) return;
          if (!isMobileViewport) {
            if (altScrollLockRef.current || snapWheelGestureLockRef.current) return;
            desktopWheelDeltaRef.current += event.deltaY;
            if (desktopWheelResetTimeoutRef.current) {
              clearTimeout(desktopWheelResetTimeoutRef.current);
            }
            desktopWheelResetTimeoutRef.current = setTimeout(() => {
              desktopWheelDeltaRef.current = 0;
            }, 100);
            if (Math.abs(desktopWheelDeltaRef.current) < 26) return;
            const direction: 1 | -1 = desktopWheelDeltaRef.current > 0 ? 1 : -1;
            desktopWheelDeltaRef.current = 0;
            snapWheelGestureLockRef.current = true;
            if (snapWheelGestureTimeoutRef.current) {
              clearTimeout(snapWheelGestureTimeoutRef.current);
            }
            snapWheelGestureTimeoutRef.current = setTimeout(() => {
              snapWheelGestureLockRef.current = false;
            }, 700);
            stepToImage(direction);
            (window as any).__postcodeEaseDebug = {
              ...(window as any).__postcodeEaseDebug,
              branch: 'snap-desktop-step',
              direction,
            };
            return;
          }
          if (altScrollLockRef.current || snapWheelGestureLockRef.current) return;
          snapWheelGestureLockRef.current = true;
          if (snapWheelGestureTimeoutRef.current) {
            clearTimeout(snapWheelGestureTimeoutRef.current);
          }
          snapWheelGestureTimeoutRef.current = setTimeout(() => {
            snapWheelGestureLockRef.current = false;
          }, 120);
          const direction: 1 | -1 = event.deltaY > 0 ? 1 : -1;
          stepToImage(direction);
          (window as any).__postcodeEaseDebug = {
            ...(window as any).__postcodeEaseDebug,
            branch: 'snap-mobile-step',
            direction,
          };
          return;
        }
        if (altScrollLockRef.current) return;
        if (event.deltaY === 0) return;
        const direction: 1 | -1 = event.deltaY > 0 ? 1 : -1;
        stepToImage(direction);
        (window as any).__postcodeEaseDebug = {
          ...(window as any).__postcodeEaseDebug,
          branch: 'image-step',
          direction,
        };
        return;
      }

      if (isMobileViewport) {
        scrollRef.current.scrollTop += event.deltaY;
        return;
      }

      const currentTop = scrollRef.current.scrollTop;
      const rawIndex = Math.floor(
        (((currentTop % LIST_PIXEL_HEIGHT) + LIST_PIXEL_HEIGHT) % LIST_PIXEL_HEIGHT) /
          BASE_STEP_HEIGHT
      );
      const nearestImageIndex = findNearestImageIndex(rawIndex);
      let easing = 1;
      let distance = -1;
      if (nearestImageIndex !== null) {
        const rawDistance = Math.abs(nearestImageIndex - rawIndex);
        distance = Math.min(rawDistance, LIST_LENGTH - rawDistance);
        if (distance <= 1) easing = 0.02;
        else if (distance <= 2) easing = 0.03;
        else if (distance <= 3) easing = 0.05;
        else if (distance <= 5) easing = 0.08;
        else if (distance <= 8) easing = 0.14;
        else if (distance <= 16) easing = 0.28;
        else if (distance <= 30) easing = 0.5;
        else easing = 0.8;
      }

      const desktopScale = 0.12;
      const appliedDelta = event.deltaY * desktopScale * easing;
      scrollRef.current.scrollTop += appliedDelta;
      (window as any).__postcodeEaseDebug = {
        ...(window as any).__postcodeEaseDebug,
        branch: 'scroll-ease',
        rawIndex,
        nearestImageIndex,
        distance,
        easing,
        desktopScale,
        appliedDelta,
      };
    },
    [
      isAltScrollMode,
      isImagesMode,
      isMobileViewport,
      useImageStepMode,
      stepToImage,
      LIST_LENGTH,
      LIST_PIXEL_HEIGHT,
      findNearestImageIndex,
    ]
  );

  const handleTouchStart = useCallback(
    (event: React.TouchEvent<HTMLDivElement>) => {
      if (!useImageStepMode) return;
      if (event.touches.length === 0) return;
      touchStartYRef.current = event.touches[0].clientY;
      touchStepTriggeredRef.current = false;
    },
    [useImageStepMode]
  );

  const handleTouchMove = useCallback(
    (event: React.TouchEvent<HTMLDivElement>) => {
      if (!useImageStepMode) return;
      if (event.touches.length === 0) return;
      if (event.cancelable) {
        event.preventDefault();
      }
      if (touchStepTriggeredRef.current) return;
      const startY = touchStartYRef.current;
      if (startY === null) return;
      const delta = startY - event.touches[0].clientY;
      if (Math.abs(delta) < 24) return;
      if (altScrollLockRef.current) return;
      touchStepTriggeredRef.current = true;
      stepToImage(delta > 0 ? 1 : -1);
    },
    [useImageStepMode, stepToImage]
  );

  const handleTouchEnd = useCallback(() => {
    touchStartYRef.current = null;
    touchStepTriggeredRef.current = false;
  }, []);

  useEffect(() => {
    return () => {
      if (snapWheelGestureTimeoutRef.current) {
        clearTimeout(snapWheelGestureTimeoutRef.current);
      }
      if (desktopWheelResetTimeoutRef.current) {
        clearTimeout(desktopWheelResetTimeoutRef.current);
      }
      if (sidebarAlignTimeoutRef.current) {
        clearTimeout(sidebarAlignTimeoutRef.current);
      }
      if (snapFinalizeTimeoutRef.current) {
        clearTimeout(snapFinalizeTimeoutRef.current);
      }
      if (snapAnimRafRef.current !== null) {
        cancelAnimationFrame(snapAnimRafRef.current);
      }
    };
  }, []);

  useEffect(() => {
    const sidebar = sidebarRef.current;
    if (!sidebar) return;
    const updateHeight = () => setSidebarViewportHeight(sidebar.clientHeight);
    updateHeight();
    const observer = new ResizeObserver(updateHeight);
    observer.observe(sidebar);
    return () => observer.disconnect();
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
    (window as any).__postcodeEaseDebug = {
      status: 'ready',
      mode: isImagesMode ? 'images' : isAltScrollMode ? 'snap' : 'scroll',
      activeIndex,
      note: 'Live wheel/debug metrics populate in all modes; scroll easing fields are present in Scroll mode.',
    };
  }, [activeIndex, isAltScrollMode, isImagesMode]);

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
      if (isAltScrollMode && !isImagesMode) {
        const target = snapTargetIndexRef.current ?? findNearestImageIndex(index);
        if (target !== null) {
          snapTargetIndexRef.current = null;
          if (target !== index) {
            scrollToIndex(target, 'auto');
          }
          setActiveIndex(target);
          setIsLanded(true);
          return;
        }
      }
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
    scrollToIndex,
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

  const alignSidebarToActiveDot = useCallback(() => {
    const sidebar = sidebarRef.current;
    if (!sidebar || LIST_LENGTH === 0) return;
    const activePostcode = POSTCODES[activeIndex]?.postcode;
    if (!activePostcode) return;

    const activeRow = sidebar.querySelector<HTMLButtonElement>(
      `[data-postcode="${activePostcode}"]`
    );
    if (!activeRow) return;
    const clamp = (value: number) => {
      const maxTop = Math.max(0, sidebar.scrollHeight - sidebar.clientHeight);
      return Math.min(maxTop, Math.max(0, value));
    };

    const align = () => {
      const targetTop =
        activeRow.offsetTop + activeRow.offsetHeight / 2 - sidebar.clientHeight / 2;
      sidebar.scrollTop = clamp(targetTop);

      const activeRect = activeRow.getBoundingClientRect();
      const sidebarRect = sidebar.getBoundingClientRect();
      const markerCenter = sidebarRect.top + sidebarRect.height / 2;
      const activeCenter = activeRect.top + activeRect.height / 2;
      const delta = activeCenter - markerCenter;
      if (Math.abs(delta) > 0.5) {
        sidebar.scrollTop = clamp(sidebar.scrollTop + delta);
      }
    };

    align();
    const raf = requestAnimationFrame(align);
    if (sidebarAlignTimeoutRef.current) {
      clearTimeout(sidebarAlignTimeoutRef.current);
    }
    sidebarAlignTimeoutRef.current = setTimeout(align, 90);
    return () => cancelAnimationFrame(raf);
  }, [POSTCODES, activeIndex, LIST_LENGTH]);

  useEffect(() => {
    const cancel = alignSidebarToActiveDot();
    return () => {
      if (typeof cancel === 'function') cancel();
    };
  }, [
    alignSidebarToActiveDot,
    mobileImageFrame.top,
    mobileImageFrame.bottom,
    mobileImageFrame.height,
  ]);

  useEffect(() => {
    if (typeof document === 'undefined' || !(document as any).fonts?.ready) return;
    let cancelled = false;
    (document as any).fonts.ready.then(() => {
      if (!cancelled) {
        alignSidebarToActiveDot();
      }
    });
    return () => {
      cancelled = true;
    };
  }, [alignSidebarToActiveDot]);

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
  const landedItem = POSTCODES[landedImageIndex] || activeItem;
  const dotRowHeight = isMobileViewport ? 16 : 24;
  const railEdgeSpacer = Math.max(0, sidebarViewportHeight / 2 - dotRowHeight / 2);
  const mobileRailStyle = isMobileViewport
    ? {
        top: `${mobileImageFrame.top}px`,
        bottom: `${mobileImageFrame.bottom}px`,
        left: `${mobileImageFrame.left + 4}px`,
      }
    : undefined;
  const mobileMenuStyle = isMobileViewport
    ? { top: `${mobileImageFrame.top + 12}px`, right: `${mobileImageFrame.right + 12}px` }
    : undefined;
  const mobileLogoStyle = isMobileViewport
    ? { top: `${mobileImageFrame.top + 12}px`, left: `${mobileImageFrame.left + 12}px` }
    : undefined;
  const mobileFooterStyle = isMobileViewport
    ? {
        bottom: `${mobileImageFrame.bottom + 12}px`,
        left: `${mobileImageFrame.left + 12}px`,
        right: `${mobileImageFrame.right + 12}px`,
      }
    : undefined;
  const mobileCenterStyle = isMobileViewport
    ? {
        top: `${mobileImageFrame.top}px`,
        bottom: `${mobileImageFrame.bottom}px`,
        left: `${mobileImageFrame.left}px`,
        right: `${mobileImageFrame.right}px`,
      }
    : undefined;
  const sideRailStyle = isMobileViewport
    ? mobileRailStyle
    : { top: '10px', bottom: '0px' };
  const dotRailMaskStyle = {
    WebkitMaskImage:
      isMobileViewport
        ? 'linear-gradient(to bottom, transparent 0px, transparent 34px, black 66px, black calc(100% - 34px), transparent 100%)'
        : 'linear-gradient(to bottom, transparent 0px, transparent 74px, black 138px, black calc(100% - 40px), transparent 100%)',
    maskImage:
      isMobileViewport
        ? 'linear-gradient(to bottom, transparent 0px, transparent 34px, black 66px, black calc(100% - 34px), transparent 100%)'
        : 'linear-gradient(to bottom, transparent 0px, transparent 74px, black 138px, black calc(100% - 40px), transparent 100%)',
    WebkitMaskRepeat: 'no-repeat',
    maskRepeat: 'no-repeat',
    WebkitMaskSize: '100% 100%',
    maskSize: '100% 100%',
  } as React.CSSProperties;

  return (
    <div
      className={`relative overflow-hidden select-none ${isMobileViewport ? 'bg-black' : isAltColorMode ? 'bg-white' : 'bg-[#dc1928]'}`}
      style={{
        fontFamily: "'APTypeProDisplay', sans-serif",
        fontWeight: 700,
        touchAction: useImageStepMode ? 'none' : 'pan-y',
        width: `${viewport.width}px`,
        height: `${viewport.height}px`,
      }}
      onWheel={forwardWheelToMain}
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchMove}
      onTouchEnd={handleTouchEnd}
      onTouchCancel={handleTouchEnd}
    >
      {isMobileViewport && (
        <div
          className={`absolute z-[1] transition-opacity duration-150 ${
            isLanded ? 'opacity-0' : 'opacity-100'
          } ${isAltColorMode ? 'bg-white' : 'bg-[#dc1928]'}`}
          style={mobileCenterStyle}
        />
      )}

      <div
        className={`absolute top-4 right-4 z-[80] flex items-center h-10 md:h-12 gap-3 text-xs tracking-wider ${
          isAltColorMode && !isLanded ? 'text-gray-500' : 'text-white'
        }`}
        style={{ ...mobileMenuStyle, fontWeight: 400 }}
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
          className={`cursor-pointer select-none font-normal ${
            isAltColorMode
              ? 'opacity-100 font-bold'
              : 'opacity-70 hover:opacity-100'
          }`}
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
          className={`cursor-pointer select-none font-normal ${
            !isAltScrollMode
              ? 'opacity-100 font-bold'
              : 'opacity-70 hover:opacity-100'
          }`}
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
          className={`cursor-pointer select-none font-normal ${
            isAltScrollMode
              ? 'opacity-100 font-bold'
              : 'opacity-70 hover:opacity-100'
          }`}
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
          className={`cursor-pointer select-none font-normal ${
            isImagesMode
              ? 'opacity-100 font-bold'
              : 'opacity-70 hover:opacity-100'
          }`}
        >
          Images
        </span>
      </div>

      <div className="absolute top-4 left-4 z-[80] pointer-events-none" style={mobileLogoStyle}>
        <img
          src={isAltColorMode ? apLogoRed : apLogoWhite}
          alt="Australia Post"
          className="h-10 w-10 md:h-12 md:w-12 object-contain select-none"
          draggable={false}
        />
      </div>

      {!isImagesMode && (
      <aside className="absolute left-0 md:left-4 top-0 bottom-0 z-[60] w-7 md:w-12" style={sideRailStyle}>
        <div className="pointer-events-none absolute left-0 right-0 top-1/2 -translate-y-1/2 flex items-center justify-center">
          <span className={`h-2.5 w-2.5 md:h-4 md:w-4 rounded-full border ${isAltColorMode ? 'border-[#212129]/60' : 'border-white/60'}`} />
        </div>
        <div ref={sidebarRef} className="hide-scrollbar h-full overflow-y-scroll" style={dotRailMaskStyle}>
          <div aria-hidden="true" style={{ height: `${railEdgeSpacer}px` }} />
          {UNIQUE_POSTCODES.map((entry) => {
            const isActive = entry.postcode === activeItem.postcode;
            const hasResolvedImage = RESOLVED_IMAGE_POSTCODES.has(entry.postcode);
            const hasAnyImage = ANY_IMAGE_POSTCODES.has(entry.postcode);
            const dotClass =
              isAltColorMode && !isLanded
                ? hasResolvedImage
                  ? 'bg-gray-400'
                  : hasAnyImage
                    ? 'bg-gray-300'
                    : 'bg-gray-200'
                : hasResolvedImage
                  ? 'bg-white'
                  : hasAnyImage
                    ? 'bg-white/70'
                    : 'bg-white/25';

            return (
              <button
                key={entry.postcode}
                type="button"
                data-postcode={entry.postcode}
                onClick={() => scrollToIndex(entry.firstIndex)}
                aria-label={`${entry.postcode} ${toTitleCase(entry.suburb)}`}
                className="w-full h-4 md:h-6 flex items-center justify-center"
              >
                <span
                  className={`h-1.5 w-1.5 md:h-2.5 md:w-2.5 rounded-full ${dotClass} ${
                    isActive ? 'opacity-100' : 'opacity-80'
                  }`}
                />
              </button>
            );
          })}
          <div aria-hidden="true" style={{ height: `${railEdgeSpacer}px` }} />
        </div>
      </aside>
      )}
      
      {/* BACKGROUND LAYER */}
      <BackgroundFrame 
        visible={isLanded} 
        imageUrl={activeImageUrl}
        imageIndex={activeIndex}
        preloadUrls={STACK_MODE_PRELOAD_URLS}
        altColorMode={isAltColorMode}
        stackMode={isImagesMode || isAltScrollMode}
        mobileContain={isMobileViewport}
        onRenderedImageIndexChange={handleRenderedImageIndexChange}
      />

      {/* CENTER TYPOGRAPHY (SCROLLING STATE) */}
      <div
        className={`absolute inset-0 flex flex-col items-center justify-center transition-all duration-180 pointer-events-none z-10 ${isLanded ? 'opacity-0 scale-95' : 'opacity-100 scale-100'}`}
        style={mobileCenterStyle}
      >
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
      <div className={`absolute bottom-0 left-0 right-0 p-6 md:p-10 flex items-center justify-center transition-all duration-120 z-30 pointer-events-none ${isLanded ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-4'}`} style={mobileFooterStyle}>
        <div className="flex flex-row items-center justify-center gap-3 md:gap-8 text-[clamp(0.95rem,4.8vw,2.9rem)] md:text-5xl font-bold tracking-[0.015em] text-center text-white whitespace-nowrap">
          <span>{landedItem.postcode}</span>
          <span className="font-bold whitespace-nowrap">{toTitleCase(landedItem.suburb)}, {landedItem.state.toUpperCase()}</span>
        </div>
      </div>

      {/* SCROLL CAPTURE LAYER (INVISIBLE) */}
      <div 
        ref={scrollRef}
        className={`scroll-master h-full w-full overflow-y-scroll absolute inset-0 z-50 cursor-ns-resize opacity-0 ${useImageStepMode ? 'pointer-events-none' : 'pointer-events-auto'}`}
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
