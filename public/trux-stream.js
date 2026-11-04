/* TruX Code — paced reply reveal.

   The network delivers a reply in uneven bursts. Painting each burst as it lands looks jumpy, so this
   engine sits between the stream and the screen:

   - Text is revealed one line at a time (a line break, or about one screen line of text), never letter by
     letter or word by word. Lines are released on a steady beat that speeds up when a backlog builds, so the
     reply flows like a smooth cascade instead of arriving in lumps.
   - Every line fades in on its own clock: from transparent, slightly blurred and wrapped in a soft dark glow
     to clear text (see .tx-fade in trux-v3.css). Because lines start a beat apart, 3-4 of them are always
     mid-fade, which is what makes it look continuous.
   - While the reply streams, a soft veil (.tx-veil) eases over the last few lines.
   - When the model finishes, the rest drains quickly and the last lines are allowed to finish fading before
     the reply is considered done. flush() shows everything at once (Stop, errors, hidden tabs, reduced motion).

   Exposed as window.truxStream.create(options) -> { push, finish, flush, dispose }. */
(function () {
  'use strict';

  var FADE_MS = 950;        // how long a newly shown line takes to fade in
  var LINE_CHARS = 90;      // a long paragraph is released in pieces about one screen line long
  var STALL_MS = 260;       // if the model pauses mid-line, show the words that have arrived after this long
  var MAX_DRAIN_MS = 1100;  // after the model is done, show everything within this long
  var FRAME_MS = 33;        // repaint at most ~30 times a second (each repaint re-renders the markdown)

  // Time between lines: slower for a trickle (calm), faster as the backlog grows (never falls behind).
  function beat(units, finished) {
    var ms = units >= 12 ? 22 : units >= 6 ? 45 : units >= 3 ? 80 : units >= 2 ? 105 : 135;
    return finished ? ms * 0.5 : ms;
  }

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
    var painted = -1;
    var finished = false;
    var disposed = false;
    var raf = 0;
    var lastPaint = 0;
    var lastReveal = 0;
    var drainStart = 0;
    var doneResolve = null;
    var donePromise = null;
    var safetyTimer = 0;
    var chunks = [];       // pieces still fading: { start, end, t0 } in offsets of the rendered text
    var renderedLength = 0;

    // The next piece to show: up to the end of the current line, or about LINE_CHARS of a long one, cut at a
    // space. Returns the new reveal position, or `shown` when a full piece has not arrived yet.
    function nextPiece(force) {
      var rest = target.length - shown;
      if (rest <= 0) return shown;
      var nl = target.indexOf('\n', shown);
      var end;
      if (nl >= 0 && nl - shown <= LINE_CHARS) {
        end = nl + 1;
        while (end < target.length && target.charAt(end) === '\n') end += 1; // swallow blank lines with their line
        return end;
      }
      if (rest >= LINE_CHARS) {
        var cut = target.indexOf(' ', shown + LINE_CHARS - 20);
        end = cut >= 0 && cut - shown < LINE_CHARS + 30 ? cut + 1 : shown + LINE_CHARS;
        return Math.min(end, target.length);
      }
      if (force) {
        var space = target.lastIndexOf(' ', target.length - 1);
        return finished || space <= shown ? target.length : space + 1; // keep a half-typed last word back
      }
      return shown;
    }

    function setVeil(on) {
      if (element && element.classList) element.classList.toggle('tx-veil', on);
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
      setVeil(withFade && !finished);
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
      setVeil(false);
      if (safetyTimer) { clearTimeout(safetyTimer); safetyTimer = 0; }
      if (doneResolve) { var resolve = doneResolve; doneResolve = null; resolve(); }
    }

    function schedule() {
      if (!raf && !disposed) raf = requestAnimationFrame(tick);
    }

    function tick(now) {
      raf = 0;
      if (disposed) return;

      var backlog = target.length - shown;
      if (backlog > 0) {
        var instant = motionOff() || document.hidden ||
          (finished && drainStart && now - drainStart > MAX_DRAIN_MS);
        if (instant) {
          shown = target.length;
        } else {
          var units = Math.ceil(backlog / LINE_CHARS) + (target.slice(shown).split('\n').length - 1);
          if (!lastReveal) lastReveal = now - beat(units, finished);
          var waited = now - lastReveal;
          if (waited >= beat(units, finished)) {
            var next = nextPiece(finished || waited >= STALL_MS);
            if (next > shown) { shown = next; lastReveal = now; }
          }
        }
      }

      var more = shown < target.length;
      var animating = chunks.length > 0;
      if (shown !== painted && (now - lastPaint >= FRAME_MS || !more)) {
        paintNow(now, !motionOff());
      } else if (animating && now - lastPaint >= FRAME_MS) {
        // keep the fading lines alive until they finish
        paintNow(now, !motionOff());
      }
      animating = chunks.length > 0;

      if (more || animating) {
        schedule();
      } else if (finished) {
        resolveDone();
      } else {
        setVeil(false); // nothing left to reveal for now: let the last lines settle to full strength
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
