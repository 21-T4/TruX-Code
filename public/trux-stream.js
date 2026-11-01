/* TruX Code — paced reply reveal.

   The network delivers a reply in uneven bursts. Painting each burst as it lands looks jumpy, so this
   engine sits between the stream and the screen:

   - Text is revealed at an even pace that follows the model, trailing it slightly. The pace is the size of
     the not-yet-shown backlog divided by a time constant, so a big burst is spread over about half a second
     and a steady stream is shown at the speed it arrives (never slower on average, never ahead of it).
   - Words are revealed whole, and every newly shown piece fades in over the same duration, so text
     appears evenly instead of in block-sized steps.
   - When the model finishes, whatever is left drains quickly. flush() shows everything at once (Stop,
     errors, hidden tabs, reduced motion).

   Exposed as window.truxStream.create(options) -> { push, finish, flush, dispose }. */
(function () {
  'use strict';

  var FADE_MS = 520;        // how long a newly shown piece takes to fade in
  var CATCH_UP_S = 0.55;    // seconds to work through the backlog while the model is still writing
  var FINISH_S = 0.16;      // same, once the model is done
  var MIN_CPS = 40;         // never crawl slower than this while text is waiting
  var MAX_DRAIN_MS = 1400;  // after the model is done, show everything within this long
  var FRAME_MS = 32;        // repaint at most ~30 times a second (each repaint re-renders the markdown)

  function motionOff() {
    var root = document.documentElement;
    return root.classList.contains('tx-no-motion') ||
      (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  }

  function create(options) {
    var element = options.element;
    var article = options.article;
    var target = '';
    var shown = 0;
    var shownFloat = 0;
    var painted = -1;
    var finished = false;
    var disposed = false;
    var raf = 0;
    var lastTick = 0;
    var lastPaint = 0;
    var drainStart = 0;
    var doneResolve = null;
    var donePromise = null;
    var safetyTimer = 0;
    var chunks = [];       // pieces still fading: { start, end, t0 } in offsets of the rendered text
    var renderedLength = 0;

    function snap(n) {
      if (n >= target.length) return target.length;
      var gap = target.slice(n, n + 16).search(/\s/);
      return gap >= 0 ? n + gap + 1 : n;
    }

    // Wraps the freshly shown part of the rendered text in fading spans. Pieces that are still mid-fade from
    // earlier frames are wrapped again with a negative delay, so their animation carries on instead of restarting.
    function applyFade(now) {
      var nodes = [];
      var total = 0;
      var walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT, {
        acceptNode: function (node) {
          var parent = node.parentNode;
          return parent && parent.closest && parent.closest('.katex, .tx-copy, .tx-math-pending')
            ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT;
        }
      });
      while (walker.nextNode()) {
        nodes.push({ node: walker.currentNode, start: total });
        total += walker.currentNode.nodeValue.length;
      }

      if (total < renderedLength) {
        chunks = chunks.filter(function (c) { return c.start < total; });
        chunks.forEach(function (c) { if (c.end > total) c.end = total; });
      } else if (total > renderedLength) {
        chunks.push({ start: renderedLength, end: total, t0: now });
      }
      renderedLength = total;
      chunks = chunks.filter(function (c) { return now - c.t0 < FADE_MS; });
      if (!chunks.length) return;

      nodes.forEach(function (item) {
        var text = item.node.nodeValue;
        var start = item.start;
        var end = start + text.length;
        var cuts = [];
        chunks.forEach(function (c) {
          var a = Math.max(start, c.start);
          var b = Math.min(end, c.end);
          if (b > a) cuts.push({ a: a - start, b: b - start, t0: c.t0 });
        });
        if (!cuts.length) return;
        var fragment = document.createDocumentFragment();
        var position = 0;
        cuts.forEach(function (cut) {
          if (cut.a > position) fragment.appendChild(document.createTextNode(text.slice(position, cut.a)));
          var span = document.createElement('span');
          span.className = 'tx-fade';
          span.style.animationDelay = (-(now - cut.t0)) + 'ms';
          span.textContent = text.slice(cut.a, cut.b);
          fragment.appendChild(span);
          position = cut.b;
        });
        if (position < text.length) fragment.appendChild(document.createTextNode(text.slice(position)));
        item.node.parentNode.replaceChild(fragment, item.node);
      });
    }

    function paintNow(now, withFade) {
      painted = shown;
      lastPaint = now;
      article.classList.add('has-response');
      options.paint(element, options.render(target.slice(0, shown)), article);
      if (withFade) {
        applyFade(now);
      } else {
        chunks = [];
        renderedLength = 0;
      }
      if (options.math) options.math(element);
      if (options.follow) options.follow();
    }

    function resolveDone() {
      if (safetyTimer) { clearTimeout(safetyTimer); safetyTimer = 0; }
      if (doneResolve) { var resolve = doneResolve; doneResolve = null; resolve(); }
    }

    function schedule() {
      if (!raf && !disposed) raf = requestAnimationFrame(tick);
    }

    function tick(now) {
      raf = 0;
      if (disposed) return;
      var dt = lastTick ? Math.min(100, now - lastTick) : 16;
      lastTick = now;

      var backlog = target.length - shown;
      if (backlog > 0) {
        var instant = motionOff() || document.hidden ||
          (finished && drainStart && now - drainStart > MAX_DRAIN_MS);
        if (instant) {
          shown = target.length;
        } else {
          var rate = Math.max(MIN_CPS, backlog / (finished ? FINISH_S : CATCH_UP_S));
          shownFloat += rate * dt / 1000;
          var next = snap(Math.min(target.length, Math.floor(shownFloat)));
          if (next > shown) shown = next;
          if (shownFloat < shown) shownFloat = shown;
        }
      }

      var more = shown < target.length;
      var animating = chunks.length > 0;
      if (shown !== painted && (now - lastPaint >= FRAME_MS || !more)) {
        paintNow(now, !motionOff());
      } else if (animating && now - lastPaint >= FRAME_MS) {
        // keep the fading pieces alive until they finish
        paintNow(now, !motionOff());
      }

      if (more || (animating && !finished)) {
        schedule();
      } else if (finished && !more) {
        resolveDone();
      }
    }

    var self = {
      // Called with the full text received so far each time more arrives.
      push: function (fullText) {
        if (disposed) return;
        target = fullText;
        schedule();
      },
      // Called once the model is done. Resolves after the remaining text has been revealed.
      finish: function (fullText) {
        if (disposed) return Promise.resolve();
        target = fullText;
        finished = true;
        drainStart = performance.now();
        if (!donePromise) {
          donePromise = new Promise(function (resolve) { doneResolve = resolve; });
        }
        // requestAnimationFrame stops in background tabs; never leave the reply waiting on it.
        safetyTimer = setTimeout(function () { self.flush(target); }, MAX_DRAIN_MS + 900);
        schedule();
        return donePromise;
      },
      // Shows everything immediately and cleanly (no fade wrappers left behind).
      flush: function (fullText) {
        if (disposed) return;
        if (typeof fullText === 'string') target = fullText;
        shown = target.length;
        shownFloat = shown;
        finished = true;
        if (raf) { cancelAnimationFrame(raf); raf = 0; }
        paintNow(performance.now(), false);
        resolveDone();
      },
      dispose: function () {
        disposed = true;
        if (raf) { cancelAnimationFrame(raf); raf = 0; }
        resolveDone();
      }
    };
    return self;
  }

  window.truxStream = { create: create };
}());
