(() => {
  const storage = (source) => Object.fromEntries(
    Array.from({ length: source.length }, (_, index) => source.key(index))
      .filter(Boolean)
      .map((key) => [key, source.getItem(key)])
  );
  const images = [...document.images].map((image) => ({
    src: image.currentSrc || image.src,
    naturalWidth: image.naturalWidth,
    naturalHeight: image.naturalHeight,
  })).filter((image) => image.naturalWidth && image.naturalHeight);
  return JSON.stringify({
    captured_at: Date.now(),
    href: location.href,
    referrer: document.referrer,
    cookie: document.cookie,
    events: window.__creatorCapture?.events || [],
    images,
    localStorage: storage(localStorage),
    sessionStorage: storage(sessionStorage),
    environment: {
      userAgent: navigator.userAgent,
      language: navigator.language,
      platform: navigator.platform,
      vendor: navigator.vendor,
      hardwareConcurrency: navigator.hardwareConcurrency,
      cookieEnabled: navigator.cookieEnabled,
      onLine: navigator.onLine,
      webdriver: navigator.webdriver,
      screenWidth: screen.width,
      screenHeight: screen.height,
      availWidth: screen.availWidth,
      availHeight: screen.availHeight,
      colorDepth: screen.colorDepth,
      pixelDepth: screen.pixelDepth,
      innerWidth,
      innerHeight,
      outerWidth,
      outerHeight,
      screenX,
      screenY,
      devicePixelRatio,
    },
  });
})()
