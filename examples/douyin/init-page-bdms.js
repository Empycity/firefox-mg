(async () => {
  const config = {
    aid: 6383,
    pageId: 6241,
    paths: ["/aweme/v1/web/comment/list/", "/aweme/v1/web/comment/list/reply/"],
  };
  const before = Object.getOwnPropertyNames(window.bdms || {});
  const returned = await window.bdms.init(config);
  return JSON.stringify({
    before,
    returnedType: typeof returned,
    returnedKeys: returned && typeof returned === "object" ? Object.getOwnPropertyNames(returned) : [],
  });
})()
