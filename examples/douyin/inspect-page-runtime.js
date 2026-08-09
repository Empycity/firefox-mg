JSON.stringify({
  href: location.href,
  readyState: document.readyState,
  bdms: {
    type: typeof window.bdms,
    keys: window.bdms ? Object.getOwnPropertyNames(window.bdms) : [],
    values: window.bdms ? Object.fromEntries(Object.getOwnPropertyNames(window.bdms).map((key) => [key, typeof window.bdms[key]])) : {},
    initSource: window.bdms?.init?.toString(),
    refererSource: window.bdms?.getReferer?.toString(),
  },
  globals: Object.getOwnPropertyNames(window).filter((name) => /bdms|bogus|webmssdk|mssdk|token|sign/i.test(name)).sort(),
})
