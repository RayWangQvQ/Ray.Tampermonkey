// ==UserScript==
// @name         Bilibili 豆瓣评分助手
// @name:en      Bilibili Douban Rating Helper
// @namespace    https://github.com/RayWangQvQ/Ray.Tampermonkey/
// @version      0.2.6
// @description  为 Bilibili 电影页面补充显示豆瓣评分，支持详情页、列表页封面角标和侧边列表评分展示。
// @description:en  Add Douban ratings to Bilibili movie pages, including detail pages, list cover badges, and side-list score display.
// @author       Ray
// @homepageURL  https://github.com/RayWangQvQ/Ray.Tampermonkey/
// @supportURL   https://github.com/RayWangQvQ/Ray.Tampermonkey/
// @match        *://www.bilibili.com/movie*
// @match        *://www.bilibili.com/bangumi/play/*
// @match        *://search.bilibili.com/bangumi*
// @match        *://search.bilibili.com/pgc*
// @icon         https://raw.githubusercontent.com/RayWangQvQ/Ray.Tampermonkey/refs/heads/main/BilibiliDoubanRatingHelper/icon.svg
// @connect      www.douban.com
// @connect      movie.douban.com
// @connect      douban.com
// @connect      sec.douban.com
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_listValues
// @grant        GM_registerMenuCommand
// @run-at       document-idle
// @license      MIT
// ==/UserScript==

(() => {
  'use strict';

  const CONFIG = {
    cacheDays: 14,
    errorCacheHours: 6,
    requestIntervalMs: 1300,
    requestTimeoutMs: 15000,
    maxListItemsPerScan: 120,
    maxSideItemsPerScan: 30,
    listObserverDebounceMs: 800,
    listRootMargin: '700px',
  };

  const CACHE_PREFIX = 'bili-douban-rating:v2:';
  const MEDIA_META_CACHE_PREFIX = 'bili-media-meta:v1:';
  const DOUBAN_SEARCH = 'https://www.douban.com/search?cat=1002&q=';
  const PLAY_LINK_SELECTOR = 'a[href*="/bangumi/play/"]';

  const BAD_TEXT_RE = /^(?:播放数量|更新时间|上映时间|最高评分|全部|观看正片|TOP100|追剧|点评|查看全部|正在加载|更多|更多推荐|电影|大会员|独播|热播|即将上线|筛选|地区|风格|年份|付费|热搜|排行榜|榜单|换一换)$/;
  const SCORE_ONLY_RE = /^(?:\d(?:\.\d)?|\d{1,2}\.\d|--|暂无评分|\d+万?|\d+人看过)$/;
  const BAD_LINE_RE = /(?:播放|弹幕|追剧|更新|上映|豆瓣|评分|排行榜|热搜|人看过|万播放|全部|筛选|地区|风格|年份)/;
  const SIDE_LIST_CLASS_RE = /(?:side[-_]?list|sideList|SideList|side-list|side_list)/i;
  const SIDE_IMAGE_CLASS_RE = /(?:^|\s|_|-)(?:img|bg[-_]?item|bg_item|bgItem)(?:\s|_|-|$)/i;
  const SEARCH_MEDIA_LABEL_RE = /(?:^|\s)(电影|番剧|国创)(?:\s|$)/;
  const SEARCH_POSITIVE_META_RE = /(?:立即观看|全片|全\d+话|\d+人评分|出演:|声优:|简介:|查看全部\s*\d+\s*部相关影视作品)/;
  const SEARCH_NEGATIVE_META_RE = /(?:^|\s)(?:UP主|投稿|播放|弹幕|收藏|硬币|点赞|分P|合集|稿件)(?:\s|$)/;
  const SEARCH_DURATION_RE = /\b\d{1,2}:\d{2}(?::\d{2})?\b/;
  const SEARCH_BADGE_TEXT_RE = /^(?:豆瓣\s.*|立即观看|全片|大会员|会员|查看全部)$/;

  let currentUrl = location.href;
  let listObserver = null;
  let intersectionObserver = null;
  let scanTimer = null;

  let preparedAnchors = new WeakSet();
  let preparedCardRoots = new WeakSet();
  let preparedSideAnchors = new WeakSet();
  let preparedSearchRoots = new WeakSet();
  let pendingListInfo = new WeakMap();
  let pendingSideInfo = new WeakMap();
  let pendingSearchInfo = new WeakMap();
  let cardBadgeMap = new WeakMap();

  const floatingBadgeRecords = new Set();
  const queue = [];

  let queueRunning = false;
  let badgePositionRaf = 0;
  let badgePositionListenersBound = false;

  injectStyle();
  registerMenu();
  hookHistoryChange();
  main();

  function main() {
    if (isBiliDetailPage()) {
      handleDetailPage();
    }

    if (isBiliMovieListPage()) {
      ensureListObservers();
      ensureBadgePositionListeners();
      scheduleScanListPage(100);
    }

    if (isBiliSearchPage()) {
      ensureListObservers();
      scheduleScanSearchPage(120);
    }
  }

  function isBiliMovieListPage() {
    return location.hostname === 'www.bilibili.com' &&
      /^\/movie(?:\/|$|\?|#)/.test(location.pathname + location.search + location.hash);
  }

  function isBiliSearchPage() {
    return location.hostname === 'search.bilibili.com' &&
      /^\/(?:bangumi|pgc)(?:\/|$|\?|#)/.test(location.pathname + location.search + location.hash);
  }

  function isBiliDetailPage() {
    return location.hostname === 'www.bilibili.com' &&
      /\/bangumi\/play\/(?:ss|ep)\d+/.test(location.pathname);
  }

  async function handleDetailPage() {
    const titleEl = await waitForElement(() => findDetailTitleElement(), 800, 12).catch(() => null);
    const rawTitle = titleEl ? textOf(titleEl) : parseTitleFromDocumentTitle();
    const title = cleanTitle(rawTitle);

    if (!title) return;

    const old = document.querySelector('#bili-douban-detail-rating');

    if (old && old.dataset.title === title) return;
    if (old) old.remove();

    const box = document.createElement('div');
    box.id = 'bili-douban-detail-rating';
    box.className = 'bili-douban-detail-rating loading';
    box.dataset.title = title;
    box.textContent = '豆瓣评分：查询中…';

    insertDetailBox(box, titleEl);

    const year = extractYearFromDetailPage();
    const mediaMeta = buildMediaMeta(title, year, document.body ? document.body.innerText : '');

    try {
      const data = await getDoubanRating(title, year, mediaMeta);
      renderDetailBox(box, data, title);
    } catch (err) {
      renderDetailBox(box, fallbackData(title, err), title);
    }
  }

  function findDetailTitleElement() {
    return document.querySelector('[class*="mediainfo_mediaTitle"], h1, .media-title, .bangumi-title');
  }

  function parseTitleFromDocumentTitle() {
    return parseTitleFromText(document.title || '');
  }

  function parseTitleFromText(titleText) {
    return String(titleText || '')
      .replace(/-电影-高清正版在线观看.*$/i, '')
      .replace(/-哔哩哔哩.*$/i, '')
      .replace(/_哔哩哔哩.*$/i, '')
      .trim();
  }

  function extractYearFromDetailPage() {
    const text = document.body ? document.body.innerText : '';
    return extractYearFromRawText(text);
  }

  function extractYearFromRawText(text) {
    const release = String(text || '').match(/((?:19|20)\d{2})年\d{1,2}月\d{1,2}日上映/);

    if (release) return release[1];

    const anyYear = String(text || '').match(/(?:^|\D)((?:19|20)\d{2})年(?:\D|$)/);
    return anyYear ? anyYear[1] : '';
  }

  function insertDetailBox(box, titleEl) {
    const ratingBlock = document.querySelector('[class*="mediainfo_mediaRating"]');

    if (ratingBlock && ratingBlock.parentElement) {
      ratingBlock.insertAdjacentElement('afterend', box);
      return;
    }

    if (titleEl && titleEl.parentElement) {
      titleEl.insertAdjacentElement('afterend', box);
      return;
    }

    const app = document.querySelector('#app') || document.body;
    app.prepend(box);
  }

  function renderDetailBox(box, data, title) {
    box.classList.remove('loading');
    box.classList.toggle('error', data.error === true);
    box.innerHTML = '';

    const a = document.createElement('a');
    a.href = data.url || searchUrl(title);
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.textContent = `豆瓣评分：${formatRating(data.rating)}`;

    if (data.subjectTitle) {
      a.title = `豆瓣条目：${data.subjectTitle}`;
    }

    box.append(a);
  }

  function ensureListObservers() {
    if (!intersectionObserver && 'IntersectionObserver' in window) {
      intersectionObserver = new IntersectionObserver(entries => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;

          const anchor = entry.target;
          intersectionObserver.unobserve(anchor);

          const normalInfo = pendingListInfo.get(anchor);
          const sideInfo = pendingSideInfo.get(anchor);
          const searchInfo = pendingSearchInfo.get(anchor);

          if (normalInfo) {
            enqueue(() => fillListRating(normalInfo));
          } else if (sideInfo) {
            enqueue(() => fillSideListRating(sideInfo));
          } else if (searchInfo) {
            enqueue(() => fillSearchResultRating(searchInfo));
          }
        }
      }, { rootMargin: CONFIG.listRootMargin });
    }

    if (!listObserver) {
      listObserver = new MutationObserver(() => {
        if (isBiliMovieListPage()) {
          scheduleScanListPage(CONFIG.listObserverDebounceMs);
        }

        if (isBiliSearchPage()) {
          scheduleScanSearchPage(CONFIG.listObserverDebounceMs);
        }

        scheduleBadgePositionUpdate();
      });

      listObserver.observe(document.body, {
        childList: true,
        subtree: true,
      });
    }
  }

  function ensureBadgePositionListeners() {
    if (badgePositionListenersBound) return;

    badgePositionListenersBound = true;

    window.addEventListener('scroll', scheduleBadgePositionUpdate, true);
    window.addEventListener('resize', scheduleBadgePositionUpdate, true);

    setInterval(() => {
      if (floatingBadgeRecords.size) {
        scheduleBadgePositionUpdate();
      }
    }, 1200);
  }

  function scheduleScanListPage(delay = 0) {
    clearTimeout(scanTimer);
    scanTimer = setTimeout(scanListPage, delay);
  }

  function scheduleScanSearchPage(delay = 0) {
    clearTimeout(scanTimer);
    scanTimer = setTimeout(scanSearchPageResults, delay);
  }

  function scanListPage() {
    if (!isBiliMovieListPage()) return;

    /**
     * 先扫顶部 side-list。
     * side-list 现在只在电影名下面显示评分，不再做复杂图片定位。
     */
    scanTopSideListMovieItems();
    scanNormalCoverMovieCards();
    scheduleBadgePositionUpdate();
  }

  function scanNormalCoverMovieCards() {
    const anchors = Array.from(document.querySelectorAll(PLAY_LINK_SELECTOR));
    let preparedCount = 0;

    for (const anchor of anchors) {
      if (preparedCount >= CONFIG.maxListItemsPerScan) break;
      if (preparedAnchors.has(anchor)) continue;
      if (preparedSideAnchors.has(anchor)) continue;
      if (isTopSideListAreaAnchor(anchor)) continue;
      if (!isVisibleEnough(anchor)) continue;

      /**
       * 普通列表仍然只查询链接内部有封面图的电影卡片。
       * 热搜、排行榜、纯文字链接不会进入这个查询队列。
       */
      const coverMedia = findCoverMedia(anchor);
      if (!coverMedia) continue;

      const cardRoot = findLikelyMovieCardRoot(anchor, coverMedia);

      if (!cardRoot || preparedCardRoots.has(cardRoot)) {
        preparedAnchors.add(anchor);
        continue;
      }

      const title = extractListTitle(anchor, cardRoot);
      if (!title) continue;

      const year = extractYearFromCard(cardRoot);

      preparedAnchors.add(anchor);
      preparedCardRoots.add(cardRoot);

      const info = {
        kind: 'normal-cover-card',
        anchor,
        cardRoot,
        coverMedia,
        title,
        year,
      };

      pendingListInfo.set(anchor, info);

      if (intersectionObserver) {
        intersectionObserver.observe(anchor);
      } else {
        enqueue(() => fillListRating(info));
      }

      preparedCount += 1;
    }
  }

  function scanTopSideListMovieItems() {
    const anchors = Array.from(document.querySelectorAll(PLAY_LINK_SELECTOR));
    let preparedCount = 0;

    for (const anchor of anchors) {
      if (preparedCount >= CONFIG.maxSideItemsPerScan) break;
      if (preparedSideAnchors.has(anchor)) continue;
      if (preparedAnchors.has(anchor)) continue;
      if (!isVisibleEnough(anchor)) continue;
      if (!isLikelyTopSideListAnchor(anchor)) continue;

      const sideRoot = findSideListRoot(anchor);
      const itemRoot = anchor.closest('li') || anchor;

      /**
       * 避免同一个 li 里既有图片链接又有标题链接时重复插入评分。
       */
      if (itemRoot.dataset.biliDoubanSidePrepared === '1') {
        preparedSideAnchors.add(anchor);
        continue;
      }

      const title = extractSideListTitle(anchor, itemRoot);

      if (!title) continue;

      preparedSideAnchors.add(anchor);
      itemRoot.dataset.biliDoubanSidePrepared = '1';

      const info = {
        kind: 'top-side-list',
        anchor,
        sideRoot,
        itemRoot,
        title,
        year: extractYearFromCard(itemRoot) || extractYearFromCard(sideRoot),
        data: null,
      };

      pendingSideInfo.set(anchor, info);

      /**
       * 简单显示：先在电影名下面放一个“豆瓣 …”。
       * 查询完成后再更新成具体评分。
       */
      ensureSideListInlineBadge(anchor, itemRoot).textContent = '豆瓣 …';

      if (intersectionObserver) {
        intersectionObserver.observe(anchor);
      } else {
        enqueue(() => fillSideListRating(info));
      }

      preparedCount += 1;
    }
  }

  async function fillListRating(info) {
    const { anchor, cardRoot, coverMedia, title, year } = info;

    if (!document.contains(anchor)) return;
    if (!document.contains(cardRoot)) return;
    if (!document.contains(coverMedia)) return;
    if (cardRoot.dataset.biliDoubanDone === '1') return;

    const badge = ensureFloatingListBadge(cardRoot, coverMedia);
    badge.textContent = '豆瓣 …';
    badge.title = `正在查询：${title}`;

    positionFloatingBadge(badge, coverMedia);

    try {
      const data = await getDoubanRating(title, year);
      updateBadge(badge, data, title);
      cardRoot.dataset.biliDoubanDone = '1';
    } catch (err) {
      updateBadge(badge, fallbackData(title, err), title);
      cardRoot.dataset.biliDoubanDone = '1';
    }
  }

  async function fillSideListRating(info) {
    const { anchor, itemRoot, title, year } = info;

    if (!document.contains(anchor)) return;
    if (!document.contains(itemRoot)) return;
    if (itemRoot.dataset.biliDoubanSideDone === '1') return;

    const badge = ensureSideListInlineBadge(anchor, itemRoot);

    badge.textContent = '豆瓣 …';
    badge.title = `正在查询：${title}`;

    try {
      const data = await getDoubanRating(title, year);
      info.data = data;
      updateSideListInlineBadge(badge, data, title);
      itemRoot.dataset.biliDoubanSideDone = '1';
    } catch (err) {
      const data = fallbackData(title, err);
      info.data = data;
      updateSideListInlineBadge(badge, data, title);
      itemRoot.dataset.biliDoubanSideDone = '1';
    }
  }

  async function fillSearchResultRating(info) {
    const { root, target, title, year, primaryLink } = info;

    if (!document.contains(root)) return;
    if (!document.contains(target)) return;
    if (root.dataset.biliDoubanSearchDone === '1') return;

    const badge = ensureSearchInlineBadge(info);
    badge.textContent = '豆瓣 …';
    badge.title = `正在查询：${title}`;

    try {
      const mediaMeta = await getBiliMediaMeta(primaryLink, title, year);
      const finalTitle = mediaMeta.title || title;
      const finalYear = mediaMeta.year || year;
      const data = await getDoubanRating(finalTitle, finalYear, mediaMeta);
      updateSearchInlineBadge(badge, data, finalTitle);
      root.dataset.biliDoubanSearchDone = '1';
    } catch (err) {
      updateSearchInlineBadge(badge, fallbackData(title, err), title);
      root.dataset.biliDoubanSearchDone = '1';
    }
  }

  function ensureFloatingListBadge(cardRoot, coverMedia) {
    let badge = cardBadgeMap.get(cardRoot);

    if (badge && document.contains(badge)) {
      positionFloatingBadge(badge, coverMedia);
      return badge;
    }

    badge = document.createElement('span');
    badge.className = 'bili-douban-list-rating';

    badge.addEventListener('click', e => {
      e.preventDefault();
      e.stopPropagation();

      const url = badge.dataset.url;

      if (url) {
        window.open(url, '_blank', 'noopener,noreferrer');
      }
    }, true);

    /**
     * 不 append 到 B 站封面容器内部，避免被 overflow / 遮罩 / 内部定位裁剪。
     * 挂到 body 后，用 fixed 坐标贴住真实图片右上角。
     */
    document.body.appendChild(badge);

    cardBadgeMap.set(cardRoot, badge);
    floatingBadgeRecords.add({
      badge,
      cardRoot,
      coverMedia,
    });

    positionFloatingBadge(badge, coverMedia);

    return badge;
  }

  function ensureSideListInlineBadge(anchor, itemRoot = null) {
    const root = itemRoot || anchor.closest('li') || anchor;

    let badge = root.querySelector('.bili-douban-side-rating');

    if (badge) return badge;

    badge = document.createElement('span');
    badge.className = 'bili-douban-side-rating';
    badge.textContent = '豆瓣 …';

    badge.addEventListener('click', e => {
      e.preventDefault();
      e.stopPropagation();

      const url = badge.dataset.url;

      if (url) {
        window.open(url, '_blank', 'noopener,noreferrer');
      }
    }, true);

    /**
     * 尽量挂到电影名元素下面。
     * 找不到明确标题元素时，就挂到 li / anchor 里。
     */
    const titleHost = findSideListTitleHost(anchor, root);

    if (titleHost && document.contains(titleHost)) {
      titleHost.appendChild(badge);
    } else {
      root.appendChild(badge);
    }

    return badge;
  }

  function ensureSearchInlineBadge(info) {
    const { root, titleHost } = info;

    let badge = root.querySelector('.bili-douban-search-rating');

    if (badge) return badge;

    badge = document.createElement('span');
    badge.className = 'bili-douban-search-rating';
    badge.textContent = '豆瓣 …';

    badge.addEventListener('click', e => {
      e.preventDefault();
      e.stopPropagation();

      const url = badge.dataset.url;

      if (url) {
        window.open(url, '_blank', 'noopener,noreferrer');
      }
    }, true);

    const host = titleHost && document.contains(titleHost) ? titleHost : root;

    if (host !== root && host.parentElement) {
      host.insertAdjacentElement('afterend', badge);
    } else {
      root.appendChild(badge);
    }

    return badge;
  }

  function findSearchTitleHost(root, primaryLink) {
    const candidates = [
      primaryLink,
      ...Array.from(root.querySelectorAll('[title], [aria-label], [class*="title"], [class*="Title"], [class*="name"], [class*="Name"]')),
    ].filter(Boolean);

    const usable = candidates
      .filter(el => isElement(el))
      .filter(el => !el.classList.contains('bili-douban-search-rating'))
      .filter(el => {
        const text = normalizeSpace(el.innerText || el.textContent || el.getAttribute('title') || el.getAttribute('aria-label') || '');
        return isGoodMovieTitle(findFirstUsableTitleInText(text));
      });

    if (!usable.length) {
      return primaryLink || root;
    }

    usable.sort((a, b) => scoreSearchTitleHost(b) - scoreSearchTitleHost(a));
    return usable[0];
  }

  function scoreSearchTitleHost(el) {
    const cls = String(el.className || '');
    const text = normalizeSpace(el.innerText || el.textContent || '');
    const title = normalizeSpace(el.getAttribute('title') || el.getAttribute('aria-label') || '');

    let score = 0;

    if (text) score += 100;
    if (title) score += 30;
    if (/title|Title|name|Name/.test(cls)) score += 80;
    if (el.matches && /\/bangumi\/play\//.test(el.getAttribute('href') || '')) score += 40;
    if (SIDE_IMAGE_CLASS_RE.test(cls)) score -= 120;

    return score;
  }

  function findSideListTitleHost(anchor, itemRoot) {
    const root = itemRoot || anchor.closest('li') || anchor;

    const candidates = [
      anchor,
      ...Array.from(root.querySelectorAll([
        PLAY_LINK_SELECTOR,
        '[title]',
        '[aria-label]',
        '[class*="title"]',
        '[class*="Title"]',
        '[class*="name"]',
        '[class*="Name"]',
      ].join(','))),
    ].filter(Boolean);

    const usable = candidates
      .filter(el => isElement(el))
      .filter(el => !el.classList.contains('bili-douban-side-rating'))
      .filter(el => !el.classList.contains('bili-douban-list-rating'))
      .filter(el => {
        const cls = String(el.className || '');
        const text = normalizeSpace(el.innerText || el.textContent || el.getAttribute('title') || el.getAttribute('aria-label') || '');

        /**
         * 避免把评分挂到纯图片链接 / bg-item 上。
         */
        if (SIDE_IMAGE_CLASS_RE.test(cls) && !normalizeSpace(el.innerText || el.textContent)) {
          return false;
        }

        return isGoodMovieTitle(findFirstUsableTitleInText(text));
      });

    if (!usable.length) {
      return anchor;
    }

    usable.sort((a, b) => scoreSideListTitleHost(b) - scoreSideListTitleHost(a));

    return usable[0];
  }

  function scoreSideListTitleHost(el) {
    const cls = String(el.className || '');
    const text = normalizeSpace(el.innerText || el.textContent || '');
    const title = normalizeSpace(el.getAttribute('title') || el.getAttribute('aria-label') || '');

    let score = 0;

    if (text) score += 100;
    if (title) score += 40;
    if (/title|Title|name|Name/.test(cls)) score += 80;
    if (el.matches && el.matches(PLAY_LINK_SELECTOR)) score += 30;

    /**
     * 图片 / 背景图元素不适合作为“电影名下面”的挂载点。
     */
    if (SIDE_IMAGE_CLASS_RE.test(cls)) {
      score -= 120;
    }

    return score;
  }

  function updateSideListInlineBadge(badge, data, title) {
    badge.classList.toggle('error', data.error === true);
    badge.textContent = `豆瓣 ${formatRating(data.rating)}`;
    badge.dataset.url = data.url || searchUrl(title);

    badge.title = data.error
      ? `未取到评分，点击去豆瓣搜索：${title}`
      : `豆瓣：${data.subjectTitle || title}`;
  }

  function updateSearchInlineBadge(badge, data, title) {
    badge.classList.toggle('error', data.error === true);
    badge.textContent = `豆瓣 ${formatRating(data.rating)}`;
    badge.dataset.url = data.url || searchUrl(title);

    badge.title = data.error
      ? `未取到评分，点击去豆瓣搜索：${title}`
      : `豆瓣：${data.subjectTitle || title}`;
  }

  function positionFloatingBadge(badge, coverMedia) {
    if (!badge || !coverMedia || !document.contains(coverMedia)) {
      if (badge) badge.style.display = 'none';
      return;
    }

    const rect = coverMedia.getBoundingClientRect();

    const hidden =
      rect.width < 30 ||
      rect.height < 30 ||
      rect.right <= 0 ||
      rect.bottom <= 0 ||
      rect.left >= window.innerWidth ||
      rect.top >= window.innerHeight ||
      !isVisibleEnough(coverMedia);

    if (hidden) {
      badge.style.display = 'none';
      return;
    }

    /**
     * left 用图片右边缘，transformX(-100%) 让徽标右边贴在图片右侧。
     * 这样不需要提前知道徽标宽度，也不会出现右侧被裁掉。
     */
    const x = clamp(rect.right - 6, 8, window.innerWidth - 8);
    const y = clamp(rect.top + 6, 8, window.innerHeight - 8);

    badge.style.display = 'inline-flex';
    badge.style.left = `${Math.round(x)}px`;
    badge.style.top = `${Math.round(y)}px`;
  }

  function scheduleBadgePositionUpdate() {
    if (badgePositionRaf) return;

    badgePositionRaf = requestAnimationFrame(() => {
      badgePositionRaf = 0;
      updateAllFloatingBadgePositions();
    });
  }

  function updateAllFloatingBadgePositions() {
    for (const record of Array.from(floatingBadgeRecords)) {
      const { badge, cardRoot, coverMedia } = record;

      if (!badge || !document.contains(badge) || !document.contains(cardRoot) || !document.contains(coverMedia)) {
        if (badge) badge.remove();
        floatingBadgeRecords.delete(record);
        continue;
      }

      positionFloatingBadge(badge, coverMedia);
    }
  }

  function removeAllFloatingBadges() {
    for (const record of Array.from(floatingBadgeRecords)) {
      if (record.badge) {
        record.badge.remove();
      }
    }

    floatingBadgeRecords.clear();

    /**
     * side-list 评分不是浮层，而是插在文字下面。
     * SPA 跳转时也顺手清理掉。
     */
    document.querySelectorAll('.bili-douban-side-rating').forEach(el => el.remove());
    document.querySelectorAll('.bili-douban-search-rating').forEach(el => el.remove());
  }

  function scanSearchPageResults() {
    if (!isBiliSearchPage()) return;

    const anchors = Array.from(document.querySelectorAll('a[href*="/bangumi/play/"], a[href*="/video/"]'))
      .filter(anchor => !anchor.closest('.bili-douban-search-rating'));
    let preparedCount = 0;
    const seenRoots = new Set();

    for (const anchor of anchors) {
      if (preparedCount >= CONFIG.maxListItemsPerScan) break;
      if (!isVisibleEnough(anchor)) continue;

      const root = findSearchResultRoot(anchor);

      if (!root || preparedSearchRoots.has(root)) continue;
      if (hasPreparedSearchAncestor(root)) continue;
      if (seenRoots.has(root)) continue;

      seenRoots.add(root);

      const candidate = extractSearchResultCandidate(root);

      if (!candidate) {
        preparedSearchRoots.add(root);
        root.dataset.biliDoubanSearchPrepared = '1';
        continue;
      }

      const decision = detectBiliMediaCandidate(candidate);

      preparedSearchRoots.add(root);
      root.dataset.biliDoubanSearchPrepared = '1';
      root.dataset.biliDoubanSearchReason = decision.reason || '';

      if (!decision.shouldFetch) {
        continue;
      }

      const info = {
        kind: decision.kind,
        confidence: decision.confidence,
        reason: decision.reason,
        root,
        target: candidate.observeTarget || candidate.primaryLink || root,
        titleHost: candidate.titleHost || candidate.primaryLink || root,
        primaryLink: candidate.primaryLink,
        title: candidate.title,
        year: candidate.year,
      };

      pendingSearchInfo.set(info.target, info);
      ensureSearchInlineBadge(info).textContent = '豆瓣 …';

      if (intersectionObserver) {
        intersectionObserver.observe(info.target);
      } else {
        enqueue(() => fillSearchResultRating(info));
      }

      preparedCount += 1;
    }
  }

  function hasPreparedSearchAncestor(root) {
    let cur = root.parentElement;

    while (cur) {
      if (cur.dataset && cur.dataset.biliDoubanSearchPrepared === '1') {
        return true;
      }

      if (cur.querySelector && cur.querySelector(':scope > .bili-douban-search-rating')) {
        return true;
      }

      cur = cur.parentElement;
    }

    return false;
  }

  function findSearchResultRoot(anchor) {
    let cur = anchor;
    let best = null;
    let bestScore = -Infinity;

    for (let i = 0; cur && i < 10; i += 1, cur = cur.parentElement) {
      if (!isElement(cur)) continue;

      const text = normalizeSpace(cur.innerText || cur.textContent || '');
      const rect = cur.getBoundingClientRect();
      const bangumiLinkCount = cur.querySelectorAll('a[href*="/bangumi/play/"]').length;
      const videoLinkCount = cur.querySelectorAll('a[href*="/video/"]').length;

      if (rect.width < 180 || rect.height < 40) continue;
      if (text.length < 10) continue;

      const score = scoreSearchResultRootCandidate(cur, text, bangumiLinkCount, videoLinkCount);

      if (score > bestScore && bangumiLinkCount + videoLinkCount > 0) {
        best = cur;
        bestScore = score;
      }

      if (isSearchResultRootCandidate(cur, text, bangumiLinkCount, videoLinkCount)) {
        return cur;
      }
    }

    return best;
  }

  function isSearchResultRootCandidate(root, text, bangumiLinkCount, videoLinkCount) {
    if (!root) return false;

    const cls = String(root.className || '');
    const hasMediaSignals = SEARCH_MEDIA_LABEL_RE.test(text) || SEARCH_POSITIVE_META_RE.test(text);
    const hasMixedLinks = bangumiLinkCount >= 1 || (bangumiLinkCount === 0 && videoLinkCount >= 1);
    const looksLikeResultCard = /result|item|card|media|bangumi|video/i.test(cls) || root.querySelector('img, picture');

    return hasMixedLinks && (hasMediaSignals || looksLikeResultCard);
  }

  function scoreSearchResultRootCandidate(root, text, bangumiLinkCount, videoLinkCount) {
    const cls = String(root.className || '');
    const rect = root.getBoundingClientRect();
    let score = 0;

    if (SEARCH_MEDIA_LABEL_RE.test(text)) score += 120;
    if (SEARCH_POSITIVE_META_RE.test(text)) score += 90;
    if (/result|item|card|media/i.test(cls)) score += 50;
    if (root.querySelector('img, picture')) score += 25;
    if (bangumiLinkCount >= 1) score += 40;
    if (videoLinkCount >= 1) score += 10;
    if (rect.height > 500) score -= 80;
    if (rect.width > 1400) score -= 40;
    if (SEARCH_NEGATIVE_META_RE.test(text) && bangumiLinkCount === 0) score -= 120;

    return score;
  }

  function extractSearchResultCandidate(root) {
    if (!root || !document.contains(root)) return null;
    if (!isLikelyOfficialSearchMediaResult(root)) return null;

    const links = Array.from(root.querySelectorAll('a[href]'));
    const bangumiLinks = links.filter(link => /\/bangumi\/play\/(?:ss|ep)\d+/i.test(link.href));
    const videoLinks = links.filter(link => /\/video\//i.test(link.href));
    const cleanBangumiLinks = bangumiLinks.filter(link => {
      const text = textOf(link);
      return !/^(?:立即观看|全片|大会员|会员|查看全部)$/u.test(text);
    });

    const primaryLink = cleanBangumiLinks[0] || bangumiLinks[0] || videoLinks[0] || links[0] || null;

    if (!primaryLink) return null;

    const watchLink = links.find(link => /立即观看|全片/.test(textOf(link))) || null;
    const metaText = normalizeSpace(root.innerText || root.textContent || '');
    const typeLabelMatch = metaText.match(SEARCH_MEDIA_LABEL_RE);
    const typeLabel = typeLabelMatch ? typeLabelMatch[1] : '';
    const title = extractSearchResultTitle({ root, primaryLink, watchLink, metaText, typeLabel });

    if (!title) return null;

    return {
      root,
      observeTarget: root,
      primaryLink,
      watchLink,
      titleHost: findSearchTitleHost(root, primaryLink),
      title,
      typeLabel,
      metaText,
      coverMedia: findCoverMedia(root),
      year: extractYearFromText(metaText),
      hasBangumiLink: bangumiLinks.length > 0,
      hasVideoLink: videoLinks.length > 0,
    };
  }

  function extractSearchResultTitle(candidate) {
    const { primaryLink, watchLink, root, metaText } = candidate;
    const values = [];

    const add = value => {
      const text = normalizeSpace(value);

      if (text) {
        values.push(text);
      }
    };

    add(primaryLink && primaryLink.getAttribute('title'));
    add(primaryLink && primaryLink.getAttribute('aria-label'));
    add(primaryLink && primaryLink.innerText);
    add(primaryLink && primaryLink.textContent);
    add(watchLink && watchLink.previousElementSibling && textOf(watchLink.previousElementSibling));

    const titleEls = Array.from(root.querySelectorAll('[title], [aria-label], [class*="title"], [class*="Title"], [class*="name"], [class*="Name"]')).slice(0, 12);

    for (const el of titleEls) {
      if (SEARCH_BADGE_TEXT_RE.test(textOf(el))) continue;
      add(el.getAttribute('title'));
      add(el.getAttribute('aria-label'));
      add(el.innerText);
    }

    add(metaText);

    return findFirstUsableTitleInText(values.join('\n'));
  }

  function isLikelyOfficialSearchMediaResult(root) {
    const text = normalizeSpace(root.innerText || root.textContent || '');
    const bangumiLinks = root.querySelectorAll('a[href*="/bangumi/play/"]').length;
    const videoLinks = root.querySelectorAll('a[href*="/video/"]').length;
    const possibleTitle = findFirstUsableTitleInText(text);

    if (bangumiLinks === 0) {
      return false;
    }

    if (SEARCH_MEDIA_LABEL_RE.test(text)) {
      return true;
    }

    if (SEARCH_POSITIVE_META_RE.test(text)) {
      return true;
    }

    if (SEARCH_NEGATIVE_META_RE.test(text) && videoLinks > 0) {
      return false;
    }

    if (possibleTitle && !SEARCH_NEGATIVE_META_RE.test(text)) {
      return true;
    }

    return !SEARCH_DURATION_RE.test(text);
  }

  function detectBiliMediaCandidate(candidate) {
    const href = candidate.primaryLink ? candidate.primaryLink.href : '';
    const metaText = candidate.metaText || '';

    if (/\/video\//i.test(href)) {
      return {
        shouldFetch: false,
        kind: 'video',
        confidence: 'high',
        reason: 'regular-video-link',
      };
    }

    if (!/\/bangumi\/play\/(?:ss|ep)\d+/i.test(href)) {
      return {
        shouldFetch: false,
        kind: 'unknown',
        confidence: 'low',
        reason: 'unsupported-link-type',
      };
    }

    if (SEARCH_NEGATIVE_META_RE.test(metaText) || SEARCH_DURATION_RE.test(metaText)) {
      return {
        shouldFetch: false,
        kind: 'video-like',
        confidence: 'high',
        reason: 'video-style-meta',
      };
    }

    if (candidate.typeLabel && /电影|番剧|国创/.test(candidate.typeLabel)) {
      return {
        shouldFetch: true,
        kind: /电影/.test(candidate.typeLabel) ? 'movie' : 'bangumi',
        confidence: 'high',
        reason: 'bangumi-play-link+explicit-type-label',
      };
    }

    if (SEARCH_POSITIVE_META_RE.test(metaText)) {
      return {
        shouldFetch: true,
        kind: 'bangumi',
        confidence: 'medium',
        reason: 'bangumi-play-link+official-meta',
      };
    }

    if (candidate.title && !SEARCH_NEGATIVE_META_RE.test(metaText)) {
      return {
        shouldFetch: true,
        kind: 'bangumi',
        confidence: 'low',
        reason: 'bangumi-play-link+usable-title',
      };
    }

    return {
      shouldFetch: false,
      kind: 'unknown',
      confidence: 'low',
      reason: 'missing-high-confidence-signal',
    };
  }

  function updateBadge(badge, data, title) {
    badge.classList.remove('loading');
    badge.classList.toggle('error', data.error === true);
    badge.textContent = `豆瓣 ${formatRating(data.rating)}`;
    badge.dataset.url = data.url || searchUrl(title);

    badge.title = data.error
      ? `未取到评分，点击去豆瓣搜索：${title}`
      : `豆瓣：${data.subjectTitle || title}`;

    scheduleBadgePositionUpdate();
  }

  function findCoverMedia(scope) {
    const candidates = [];

    candidates.push(...scope.querySelectorAll([
      'img',
      'picture',
      'video',
      'canvas',
      '[style*="background-image"]',
      '[class*="cover"]',
      '[class*="Cover"]',
      '[class*="poster"]',
      '[class*="Poster"]',
      '[class*="pic"]',
      '[class*="Pic"]',
    ].join(',')));

    const seen = new Set();

    for (const rawEl of candidates) {
      if (!rawEl || seen.has(rawEl)) continue;
      seen.add(rawEl);

      const el = normalizeMediaElement(rawEl);

      if (isLikelyCoverMedia(el)) {
        return el;
      }
    }

    return null;
  }

  function normalizeMediaElement(el) {
    if (!el) return el;

    const tag = tagName(el);

    if (tag === 'PICTURE') {
      return el.querySelector('img') || el;
    }

    return el;
  }

  function isLikelyCoverMedia(el) {
    if (!isElement(el)) return false;

    const rect = el.getBoundingClientRect();

    /**
     * 过滤小图标、头像、徽章。
     */
    if (rect.width < 70 || rect.height < 50) return false;
    if (rect.width * rect.height < 4500) return false;

    const style = getComputedStyle(el);

    if (style.display === 'none') return false;
    if (style.visibility === 'hidden') return false;
    if (Number(style.opacity || 1) === 0) return false;

    const tag = tagName(el);

    if (['IMG', 'PICTURE', 'VIDEO', 'CANVAS'].includes(tag)) {
      return true;
    }

    const bg = style.backgroundImage;

    return !!bg && bg !== 'none' && /url\(/i.test(bg);
  }

  function findLikelyMovieCardRoot(anchor, coverMedia) {
    let cur = anchor;
    let best = anchor;

    for (let i = 0; cur && i < 7; i += 1, cur = cur.parentElement) {
      if (!cur.contains(coverMedia)) continue;

      const rect = cur.getBoundingClientRect();

      /**
       * 防止一路爬到整个分区、整个页面。
       */
      if (rect.width < 70 || rect.height < 50) continue;
      if (rect.width > 900 || rect.height > 900) continue;

      best = cur;

      const maybeTitle = findFirstUsableTitleInText([
        cur.getAttribute('title'),
        cur.getAttribute('aria-label'),
        cur.innerText,
      ].filter(Boolean).join('\n'));

      if (maybeTitle) {
        return cur;
      }
    }

    return best;
  }

  function isTopSideListAreaAnchor(anchor) {
    const rect = anchor.getBoundingClientRect();

    if (rect.top > Math.max(window.innerHeight * 1.15, 950)) return false;
    if (!anchor.closest('li')) return false;
    if (!anchor.closest('ul')) return false;

    return SIDE_LIST_CLASS_RE.test(getClassPath(anchor, 8));
  }

  function isLikelyTopSideListAnchor(anchor) {
    if (!isTopSideListAreaAnchor(anchor)) return false;

    const itemRoot = anchor.closest('li') || anchor;
    const title = extractSideListTitle(anchor, itemRoot);

    if (!isGoodMovieTitle(title)) return false;

    return true;
  }

  function findSideListRoot(anchor) {
    const explicit = anchor.closest(
      '[class*="side-list"], [class*="sideList"], [class*="SideList"], [class*="side_list"]'
    );

    if (explicit) {
      return explicit;
    }

    const ul = anchor.closest('ul');

    if (ul && ul.querySelectorAll(PLAY_LINK_SELECTOR).length >= 2) {
      return ul;
    }

    return anchor.closest('li') || anchor.parentElement || anchor;
  }

  function extractListTitle(anchor, cardRoot) {
    const values = [];

    const add = value => {
      const text = normalizeSpace(value);

      if (text) {
        values.push(text);
      }
    };

    add(anchor.getAttribute('title'));
    add(anchor.getAttribute('aria-label'));
    add(anchor.innerText);
    add(anchor.textContent);

    const titleLikeSelector = [
      '[title]',
      '[aria-label]',
      '[class*="title"]',
      '[class*="Title"]',
      '[class*="name"]',
      '[class*="Name"]',
    ].join(',');

    const titleLikeEls = Array.from(cardRoot.querySelectorAll(titleLikeSelector)).slice(0, 30);

    for (const el of titleLikeEls) {
      add(el.getAttribute('title'));
      add(el.getAttribute('aria-label'));
      add(el.innerText);
      add(el.textContent);
    }

    add(cardRoot.innerText);
    add(cardRoot.textContent);

    return findFirstUsableTitleInText(values.join('\n'));
  }

  function extractSideListTitle(anchor, itemRoot = null) {
    const root = itemRoot || anchor.closest('li') || anchor;
    const values = [];

    const add = value => {
      const text = normalizeSpace(value);

      if (text) {
        values.push(text);
      }
    };

    add(anchor.getAttribute('title'));
    add(anchor.getAttribute('aria-label'));
    add(anchor.innerText);
    add(anchor.textContent);

    if (root && root !== anchor) {
      add(root.getAttribute('title'));
      add(root.getAttribute('aria-label'));

      const titleLikeSelector = [
        '[title]',
        '[aria-label]',
        '[class*="title"]',
        '[class*="Title"]',
        '[class*="name"]',
        '[class*="Name"]',
      ].join(',');

      const titleLikeEls = Array.from(root.querySelectorAll(titleLikeSelector)).slice(0, 20);

      for (const el of titleLikeEls) {
        if (el.classList && (
          el.classList.contains('bili-douban-list-rating') ||
          el.classList.contains('bili-douban-side-rating')
        )) {
          continue;
        }

        add(el.getAttribute('title'));
        add(el.getAttribute('aria-label'));
        add(el.innerText);
        add(el.textContent);
      }

      add(root.innerText);
      add(root.textContent);
    }

    return findFirstUsableTitleInText(values.join('\n'));
  }

  function findFirstUsableTitleInText(text) {
    const raw = normalizeSpace(text);

    if (!raw) return '';

    const bookTitle = raw.match(/《([^》]{1,60})》/);

    if (bookTitle) {
      const t = cleanTitle(bookTitle[1]);

      if (isGoodMovieTitle(t)) {
        return t;
      }
    }

    const lines = String(text || '')
      .split(/[\n\r]+/)
      .map(line => normalizeSpace(line))
      .filter(Boolean);

    for (const line of lines) {
      let t = line
        .replace(/^\d{1,2}(?:\.\d)?\s+/, '')
        .replace(/\s+\d{1,2}(?:\.\d)?\s*分?$/, '')
        .replace(/\s+(?:19|20)\d{2}年?$/, '')
        .trim();

      t = cleanTitle(t);

      if (isGoodMovieTitle(t)) {
        return t;
      }
    }

    return '';
  }

  function isGoodMovieTitle(title) {
    const t = cleanTitle(title);

    if (!t) return false;
    if (t.length < 2) return false;
    if (t.length > 42) return false;
    if (BAD_TEXT_RE.test(t)) return false;
    if (SCORE_ONLY_RE.test(t)) return false;
    if (BAD_LINE_RE.test(t)) return false;
    if (/^(?:19|20)\d{2}年?$/.test(t)) return false;
    if (!/[\u4e00-\u9fffA-Za-z0-9]/.test(t)) return false;

    return true;
  }

  function extractYearFromCard(cardRoot) {
    const text = cardRoot ? textOf(cardRoot) : '';
    const m = text.match(/(?:^|\D)((?:19|20)\d{2})年?(?:\D|$)/);

    return m ? m[1] : '';
  }

  async function getDoubanRating(rawTitle, year = '', mediaMeta = null) {
    const title = cleanTitle(rawTitle);
    const key = cacheKey(title, year);
    const cached = GM_getValue(key);

    if (cached && cached.ts) {
      const ttl = cached.data && cached.data.error
        ? CONFIG.errorCacheHours * 60 * 60 * 1000
        : CONFIG.cacheDays * 24 * 60 * 60 * 1000;

      if (Date.now() - cached.ts < ttl) {
        return cached.data;
      }
    }

    const queries = buildDoubanQueries(title);

    let lastError = null;

    for (const q of queries) {
      const url = searchUrl(q);

      try {
        const html = await gmGet(url);
        const data = parseDoubanSearch(html, url, q, year, mediaMeta);

        if (data) {
          GM_setValue(key, { ts: Date.now(), data });
          return data;
        }
      } catch (err) {
        lastError = err;
      }
    }

    const data = fallbackData(title, lastError);
    GM_setValue(key, { ts: Date.now(), data });

    return data;
  }

  async function getBiliMediaMeta(url, fallbackTitle = '', fallbackYear = '') {
    if (!url || !/\/bangumi\/play\/(?:ss|ep)\d+/i.test(String(url))) {
      return { title: fallbackTitle, year: fallbackYear };
    }

    const key = MEDIA_META_CACHE_PREFIX + String(url);
    const cached = GM_getValue(key);

    if (cached && cached.ts && Date.now() - cached.ts < CONFIG.cacheDays * 24 * 60 * 60 * 1000) {
      return cached.data || { title: fallbackTitle, year: fallbackYear };
    }

    try {
      const html = await gmGet(url);
      const data = parseBiliMediaMeta(html, url, fallbackTitle, fallbackYear);
      GM_setValue(key, { ts: Date.now(), data });
      return data;
    } catch (_) {
      return { title: fallbackTitle, year: fallbackYear };
    }
  }

  function parseBiliMediaMeta(html, url, fallbackTitle = '', fallbackYear = '') {
    if (!html) {
      return { title: fallbackTitle, year: fallbackYear };
    }

    const doc = new DOMParser().parseFromString(html, 'text/html');
    const title = cleanTitle(
      textOf(doc.querySelector('[class*="mediainfo_mediaTitle"], h1, .media-title, .bangumi-title')) ||
      parseTitleFromText(doc.title || '') ||
      fallbackTitle
    );
    const bodyText = doc.body ? (doc.body.innerText || doc.body.textContent || '') : '';
    const year = extractYearFromRawText(bodyText) || fallbackYear;

    return buildMediaMeta(title || fallbackTitle, year || fallbackYear, bodyText, url);
  }

  function parseDoubanSearch(html, sourceUrl, title, year, mediaMeta = null) {
    if (!html || /sec\.douban\.com|检测到有异常请求|为了你的帐号安全/i.test(html)) {
      throw new Error('Douban security check');
    }

    const doc = new DOMParser().parseFromString(html, 'text/html');
    const items = Array.from(doc.querySelectorAll('.result-list .result'));

    if (!items.length) {
      return null;
    }

    const candidates = items.map(item => {
      const link = item.querySelector('.content .title a, .title a, a[href*="movie.douban.com/subject/"]');
      const ratingText = textOf(item.querySelector('.rating_nums')) || '暂无评分';
      const cast = textOf(item.querySelector('.subject-cast'));
      const itemYear = extractYearFromText(cast);
      const subjectTitle = cleanSubjectTitle(textOf(link));
      const href = link ? link.getAttribute('href') : '';
      const url = resolveDoubanUrl(href) || sourceUrl;

      return {
        rating: ratingText,
        url,
        subjectTitle,
        year: itemYear,
        cast,
        staffTokens: extractStaffTokens(cast),
      };
    }).filter(x => x.url && x.subjectTitle);

    if (!candidates.length) {
      return null;
    }

    candidates.sort((a, b) => {
      return scoreCandidate(b, title, year, mediaMeta) - scoreCandidate(a, title, year, mediaMeta);
    });

    const top = candidates[0];
    const topScore = scoreCandidate(top, title, year, mediaMeta);
    const secondScore = candidates[1] ? scoreCandidate(candidates[1], title, year, mediaMeta) : -Infinity;

    return isReliableCandidate(top, title, year, mediaMeta, topScore, secondScore)
      ? top
      : null;
  }

  function scoreCandidate(candidate, title, year, mediaMeta = null) {
    const a = normalizeForCompare(candidate.subjectTitle);
    const b = normalizeForCompare(title);
    const candidateChunks = extractComparableChunks(candidate.subjectTitle);
    const titleChunks = extractComparableChunks(title);
    const staffOverlap = countOverlap(candidate.staffTokens || [], mediaMeta && mediaMeta.staffTokens ? mediaMeta.staffTokens : []);

    let score = 0;

    if (a === b) {
      score += 100;
    } else if (a.includes(b) || b.includes(a)) {
      score += 70;
    }

    if (year && candidate.year === year) {
      score += 45;
    } else if (year && candidate.year && candidate.year !== year) {
      score -= 30;
    }

    if (candidate.rating && candidate.rating !== '暂无评分') {
      score += 3;
    }

    if (titleChunks.length && candidateChunks.length) {
      for (const chunk of titleChunks) {
        if (candidateChunks.some(candidateChunk => candidateChunk === chunk)) {
          score += 14;
        } else if (a.includes(chunk)) {
          score += 8;
        }
      }
    }

    if (staffOverlap > 0) {
      score += Math.min(36, staffOverlap * 18);
    }

    return score;
  }

  function isReliableCandidate(candidate, title, year, mediaMeta = null, score = 0, secondScore = -Infinity) {
    if (!candidate) return false;

    const a = normalizeForCompare(candidate.subjectTitle);
    const b = normalizeForCompare(title);
    const titleExact = a === b;
    const titleContain = a.includes(b) || b.includes(a);
    const yearExact = !!year && candidate.year === year;
    const staffOverlap = countOverlap(candidate.staffTokens || [], mediaMeta && mediaMeta.staffTokens ? mediaMeta.staffTokens : []);
    const clearLead = score - secondScore >= 20;
    const hasStaff = !!(mediaMeta && mediaMeta.staffTokens && mediaMeta.staffTokens.length);
    const hasStrictMeta = hasStrongDisambiguationMeta(mediaMeta);

    if (!hasStrictMeta) {
      if (titleExact) return true;
      if (titleContain && yearExact && clearLead && score >= 100) return true;
      if (titleContain && clearLead && score >= 120) return true;
      return false;
    }

    if (titleExact && yearExact) return true;
    if (titleExact && staffOverlap >= 1) return true;
    if (titleContain && yearExact && staffOverlap >= 1) return true;
    if (titleExact && !hasStaff && !year && clearLead && score >= 100) return true;
    if (titleContain && yearExact && !hasStaff && clearLead && score >= 115) return true;

    return false;
  }

  function buildMediaMeta(title = '', year = '', rawText = '', sourceUrl = '') {
    return {
      title: cleanTitle(title),
      year: year || '',
      staffTokens: extractStaffTokensFromRawText(rawText),
      sourceUrl,
    };
  }

  function hasStrongDisambiguationMeta(mediaMeta) {
    return !!(
      mediaMeta && (
        (mediaMeta.staffTokens && mediaMeta.staffTokens.length > 0) ||
        mediaMeta.year
      )
    );
  }

  function extractStaffTokensFromRawText(rawText) {
    const text = String(rawText || '');
    const segments = [
      extractLabeledSegment(text, '导演'),
      extractLabeledSegment(text, '出演演员'),
      extractLabeledSegment(text, '主演'),
      extractLabeledSegment(text, '声优'),
      extractLabeledSegment(text, '配音'),
    ].filter(Boolean);

    return extractStaffTokens(segments.join(' '));
  }

  function extractLabeledSegment(text, label) {
    const pattern = new RegExp(label + '[：:]\\s*([^\\n\\r]{1,160})');
    const match = String(text || '').match(pattern);
    return match ? normalizeSpace(match[1]) : '';
  }

  function extractStaffTokens(text) {
    return unique(
      String(text || '')
        .replace(/导演|出演演员|主演|声优|配音|演员|角色|简介/gu, ' ')
        .split(/[、/／|｜,，；;：:\s]+/u)
        .map(part => normalizeSpace(part))
        .filter(Boolean)
        .filter(part => part.length >= 2)
        .filter(part => !/^(?:19|20)\d{2}$/.test(part))
        .filter(part => !/^(?:日本|中国|美国|英国|动画|电影|番剧|会员|全片)$/u.test(part))
    );
  }

  function countOverlap(a, b) {
    if (!a.length || !b.length) return 0;
    const setB = new Set(b);
    let count = 0;

    for (const item of a) {
      if (setB.has(item)) {
        count += 1;
      }
    }

    return count;
  }

  function buildDoubanQueries(title) {
    const raw = cleanTitle(title);

    return unique([
      raw,
      raw.replace(/\s+(?:电影版|剧场版)$/u, ''),
      raw.replace(/[：:].*$/u, ''),
      raw.replace(/\s*[~～〜]\s*/gu, '~'),
      raw.replace(/[：:]/gu, ' '),
      raw.replace(/\s*[~～〜].*$/u, ''),
      raw.replace(/[：:].*?[~～〜].*$/u, ''),
      ...buildChunkQueries(raw),
    ].map(cleanTitle).filter(Boolean));
  }

  function buildChunkQueries(title) {
    const chunks = extractComparableChunks(title);

    if (chunks.length < 2) {
      return [];
    }

    const queries = [];

    queries.push(chunks.slice(0, 2).join(' '));

    if (chunks.length >= 3) {
      queries.push(chunks.slice(0, 3).join(' '));
      queries.push(chunks[0] + ' ' + chunks[1]);
    }

    return queries;
  }

  function extractComparableChunks(text) {
    return unique(
      String(text || '')
        .split(/[：:~～〜·•／/|｜—\-_（）()\[\]【】\s]+/u)
        .map(part => cleanTitle(part))
        .filter(Boolean)
        .filter(part => part.length >= 2)
        .filter(part => !/^(?:19|20)\d{2}$/.test(part))
    );
  }

  function gmGet(url) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'GET',
        url,
        timeout: CONFIG.requestTimeoutMs,
        headers: {
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        },
        onload: res => {
          if (res.finalUrl && /sec\.douban\.com/.test(res.finalUrl)) {
            reject(new Error('Douban security check'));
            return;
          }

          if (res.status >= 200 && res.status < 300) {
            resolve(res.responseText);
          } else {
            reject(new Error(`HTTP ${res.status}`));
          }
        },
        onerror: () => reject(new Error('Network error')),
        ontimeout: () => reject(new Error('Request timeout')),
      });
    });
  }

  function enqueue(task) {
    queue.push(task);
    runQueue();
  }

  async function runQueue() {
    if (queueRunning) return;

    queueRunning = true;

    while (queue.length) {
      const task = queue.shift();

      try {
        await task();
      } catch (err) {
        console.warn('[Bili Douban Rating]', err);
      }

      await sleep(CONFIG.requestIntervalMs);
    }

    queueRunning = false;
  }

  function hookHistoryChange() {
    const fire = () => {
      setTimeout(() => {
        if (location.href === currentUrl) return;

        currentUrl = location.href;

        document.querySelector('#bili-douban-detail-rating')?.remove();
        removeAllFloatingBadges();

        preparedAnchors = new WeakSet();
        preparedCardRoots = new WeakSet();
        preparedSideAnchors = new WeakSet();
        preparedSearchRoots = new WeakSet();
        pendingListInfo = new WeakMap();
        pendingSideInfo = new WeakMap();
        pendingSearchInfo = new WeakMap();
        cardBadgeMap = new WeakMap();

        main();
      }, 200);
    };

    const rawPushState = history.pushState;
    const rawReplaceState = history.replaceState;

    history.pushState = function pushState(...args) {
      const ret = rawPushState.apply(this, args);
      fire();
      return ret;
    };

    history.replaceState = function replaceState(...args) {
      const ret = rawReplaceState.apply(this, args);
      fire();
      return ret;
    };

    window.addEventListener('popstate', fire);
  }

  function waitForElement(getter, delay, maxTimes) {
    return new Promise((resolve, reject) => {
      let count = 0;

      const timer = setInterval(() => {
        const el = getter();

        if (el) {
          clearInterval(timer);
          resolve(el);
          return;
        }

        count += 1;

        if (count >= maxTimes) {
          clearInterval(timer);
          reject(new Error('element not found'));
        }
      }, delay);
    });
  }

  function isVisibleEnough(el) {
    if (!isElement(el)) return false;

    const rect = el.getBoundingClientRect();

    if (rect.width === 0 || rect.height === 0) {
      return false;
    }

    const style = getComputedStyle(el);

    return style.display !== 'none' &&
      style.visibility !== 'hidden' &&
      Number(style.opacity || 1) !== 0;
  }

  function resolveDoubanUrl(href) {
    if (!href) return '';

    try {
      const u = new URL(href, 'https://www.douban.com');
      const redirected = u.searchParams.get('url');

      if (redirected) {
        return decodeURIComponent(redirected);
      }

      return u.href;
    } catch (_) {
      return '';
    }
  }

  function searchUrl(title) {
    return DOUBAN_SEARCH + encodeURIComponent(cleanTitle(title));
  }

  function fallbackData(title, err) {
    return {
      rating: 'N/A',
      url: searchUrl(title),
      subjectTitle: '',
      year: '',
      error: true,
      errorMessage: err ? String(err.message || err) : '',
    };
  }

  function formatRating(rating) {
    if (!rating) return '暂无';
    if (rating === '暂无评分') return '暂无';
    return rating;
  }

  function cacheKey(title, year) {
    return CACHE_PREFIX + normalizeForCompare(title) + ':' + (year || '');
  }

  function extractYearFromText(text) {
    const m = String(text || '').match(/(?:^|[^\d])((?:19|20)\d{2})(?:[^\d]|$)/);
    return m ? m[1] : '';
  }

  function cleanSubjectTitle(s) {
    return normalizeSpace(String(s || ''))
      .replace(/\s+/g, ' ')
      .replace(/\s*\(豆瓣\).*$/u, '')
      .trim();
  }

  function cleanTitle(s) {
    return normalizeSpace(String(s || ''))
      .replace(/^《(.+?)》.*$/u, '$1')
      .replace(/^\d{1,2}(?:\.\d)?\s*/u, '')
      .replace(/\s*[-_—|].*?(?:高清正版在线观看|哔哩哔哩|bilibili).*$/iu, '')
      .replace(/(?:中文版|国语版|粤语版|普通话版|英语版|日语版|韩语版|中字版|高清版|蓝光版|4K版|杜比版)$/iu, '')
      .replace(/[（(]\s*(?:国语|粤语|普通话|英语|日语|韩语|中文|中字|高清|蓝光|4K|杜比|修复|未删减|导演剪辑).*?[）)]$/iu, '')
      .trim();
  }

  function normalizeForCompare(s) {
    return cleanTitle(s)
      .toLowerCase()
      .replace(/[《》〈〉“”"'’‘\s:：\-—·._,，。！!？?()（）\[\]【】]/g, '');
  }

  function normalizeSpace(s) {
    return String(s || '')
      .replace(/\u00a0/g, ' ')
      .replace(/[ \t]+/g, ' ')
      .trim();
  }

  function textOf(el) {
    return normalizeSpace(el ? (el.innerText || el.textContent || '') : '');
  }

  function tagName(el) {
    return el && el.tagName ? el.tagName.toUpperCase() : '';
  }

  function isElement(el) {
    return el && el.nodeType === 1;
  }

  function getClassPath(el, depth = 6) {
    const parts = [];
    let cur = el;

    for (let i = 0; cur && i < depth; i += 1, cur = cur.parentElement) {
      parts.push(cur.className || '');
      parts.push(cur.id || '');
    }

    return String(parts.join(' '));
  }

  function unique(arr) {
    return Array.from(new Set(arr));
  }

  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function registerMenu() {
    if (typeof GM_registerMenuCommand !== 'function') return;

    GM_registerMenuCommand('清空 B 站豆瓣评分缓存', () => {
      const keys = GM_listValues().filter(k => k.startsWith(CACHE_PREFIX));
      keys.forEach(k => GM_deleteValue(k));
      alert(`已清空 ${keys.length} 条缓存。`);
    });
  }

  function injectStyle() {
    const style = document.createElement('style');

    style.textContent = `
      .bili-douban-detail-rating {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        margin: 8px 12px 8px 0;
        padding: 4px 10px;
        border-radius: 999px;
        background: rgba(0, 0, 0, 0.06);
        color: #00a65a;
        font-size: 14px;
        line-height: 1.6;
        font-weight: 600;
      }

      .bili-douban-detail-rating a {
        color: #00a65a !important;
        text-decoration: none !important;
      }

      .bili-douban-detail-rating.error,
      .bili-douban-detail-rating.error a {
        color: #999 !important;
      }

      .bili-douban-list-rating {
        position: fixed !important;
        left: 0;
        top: 0;
        transform: translateX(-100%);
        z-index: 2147483647 !important;
        box-sizing: border-box;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        min-width: 52px;
        height: 24px;
        padding: 0 7px;
        border-radius: 999px;
        user-select: none;
        cursor: pointer;
        white-space: nowrap;
        font-weight: 700;
        font-size: 12px;
        line-height: 1;
        color: #fff;
        background: rgba(0, 166, 90, 0.94);
        box-shadow: 0 2px 8px rgba(0, 0, 0, 0.24);
        backdrop-filter: blur(2px);
        -webkit-backdrop-filter: blur(2px);
        pointer-events: auto;
      }

      .bili-douban-list-rating:hover {
        background: rgba(0, 150, 82, 0.98);
      }

      .bili-douban-list-rating.error {
        background: rgba(120, 120, 120, 0.88);
      }

      .bili-douban-list-rating.error:hover {
        background: rgba(100, 100, 100, 0.94);
      }

      .bili-douban-side-rating {
        box-sizing: border-box;
        display: flex;
        align-items: center;
        justify-content: center;
        width: fit-content;
        min-width: 50px;
        height: 20px;
        margin-top: 4px;
        margin-left: 0;
        padding: 0 6px;
        border-radius: 999px;
        user-select: none;
        cursor: pointer;
        white-space: nowrap;
        font-weight: 700;
        font-size: 12px;
        line-height: 1;
        color: #fff;
        background: rgba(0, 166, 90, 0.94);
        box-shadow: 0 1px 5px rgba(0, 0, 0, 0.18);
      }

      .bili-douban-side-rating:hover {
        background: rgba(0, 150, 82, 0.98);
      }

      .bili-douban-side-rating.error {
        background: rgba(120, 120, 120, 0.88);
      }

      .bili-douban-search-rating {
        box-sizing: border-box;
        display: flex;
        align-items: center;
        justify-content: center;
        width: fit-content;
        min-width: 50px;
        height: 20px;
        margin-top: 6px;
        padding: 0 6px;
        border-radius: 999px;
        user-select: none;
        cursor: pointer;
        white-space: nowrap;
        font-weight: 700;
        font-size: 12px;
        line-height: 1;
        color: #fff;
        background: rgba(0, 166, 90, 0.94);
        box-shadow: 0 1px 5px rgba(0, 0, 0, 0.18);
      }

      .bili-douban-search-rating:hover {
        background: rgba(0, 150, 82, 0.98);
      }

      .bili-douban-search-rating.error {
        background: rgba(120, 120, 120, 0.88);
      }
    `;

    document.head.appendChild(style);
  }
})();