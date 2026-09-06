(() => {
  const read = (storage) => Object.fromEntries(
    Array.from({ length: storage.length }, (_, index) => {
      const key = storage.key(index);
      return [key, storage.getItem(key)];
    })
  );
  const result = {
    origin: location.origin,
    url: location.href,
    localStorage: read(localStorage),
    sessionStorage: read(sessionStorage)
  };
  copy(JSON.stringify(result, null, 2));
  console.log("完整 Storage 已复制，可保存为 security-storage-full.json", result);
})();
