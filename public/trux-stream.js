/* TruX Code — paced reply reveal.

   The network delivers a reply in uneven bursts. Painting each burst as it lands looks jumpy, so this
   engine sits between the stream and the screen:

   - Text flows out one word at a time at a smooth, continuous rate. The rate is never a fixed speed: it is
     worked out every frame from how much text is waiting (a big backlog flows faster, a trickle flows at a
     calm minimum), so the reply glides along a little behind the network instead of arriving in lumps and
     never falls far behind. Words are never cut in half, and inline markdown (**bold**, `code`, [links](...),
     $math$, a "## " heading marker, a ``` fence) is held back until it is complete, so a reply never shows
     stray asterisks or backticks that snap into formatting a moment later.
   - Every new word fades in on its own clock, from transparent to full colour over a fraction of a second.
     The fade animates the text colour (see .tx-fade in trux-v3.css) rather than opacity or blur, so the text
     is never lifted onto its own graphics layer: it keeps the same crisp, even rendering the whole time and
     there is no "snap" when the fade ends.
   - When the model finishes, the rest drains quickly. flush() shows everything at once (Stop, errors, hidden
     tabs, reduced motion).

   Exposed as window.truxStream.create(options) -> { push, finish, flush, dispose }. */
(function () {
  'use strict';

  var FADE_MS = 420;          // how long a newly shown word takes to fade in
  var TAU_MS = 650;           // the backlog is worked off over about this long: more waiting text, faster flow
  var FINISH_TAU_MS = 160;    // the same, once the model is done
  var MIN_CPS = 42;           // never slower than this (characters per second) while text is waiting
  var MAX_CPS = 2600;         // never faster than this
  var STALL_MS = 240;         // if the model pauses mid-word, show the part that has arrived after this long
  var HOLD_MS = 1000;         // how long unfinished markdown is waited for before it is shown as it is
  var MAX_DRAIN_MS = 1100;    // after the model is done, show everything within this long
  var FRAME_MS = 33;          // repaint at most ~30 times a second (each repaint re-renders the markdown)
  var MAX_WORD = 48;          // a "word" with no space for this long (a URL, a hash) is cut here

  var WHITESPACE = /\s/;
  var FENCE_LINE = /^[ \t]*```/;
  var BLOCK_MARKER_ONLY = /^[ \t]*(?:#{1,6}|[-*+>_]{1,3}|\d{1,3}[.)])[ \t]*$/;

  function motionOff() {
    var root = document.documentElement;
    return root.classList.contains('tx-no-motion') ||
      (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  }

  // Which inline markdown is still open at the end of `line` (the text of one line up to the reveal point)?
  // Returns the kind of thing that has to be closed: '`', '$', '**', '*', ']' (link text) or ')' (link address),
  // or '' when nothing is open.
  function openInline(line) {
    var state = '';
    for (var i = 0; i < line.length; i += 1) {
      var c = line.charAt(i);
      var next = line.charAt(i + 1);
      if (state === '`') { if (c === '`') state = ''; continue; }
      if (state === '$') { if (c === '$') state = ''; continue; }
      if (state === '**') { if (c === '*' && next === '*') { state = ''; i += 1; } continue; }
      if (state === '*') { if (c === '*') state = ''; continue; }
      if (state === ')') { if (c === ')') state = ''; continue; }
      if (state === ']') {
        if (c === ']') {
          if (next === '(') { state = ')'; i += 1; } else state = '';
        }
        continue;
      }
      if (c === '\\') { i += 1; continue; }
      if (c === '`') state = '`';
      else if (c === '$' && next && !WHITESPACE.test(next) && !/\d/.test(next)) state = '$'; // "$5" is money
      else if (c === '*' && next === '*') { state = '**'; i += 1; }
      else if (c === '*' && next && !WHITESPACE.test(next)) state = '*';
      else if (c === '[') state = ']';
    }
    return state;
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
    var lastTick = 0;
    var lastPaint = 0;
    var lastReveal = 0;
    var credit = 0;        // characters the flow has earned but not shown yet (can dip below zero after a long jump)
    var drainStart = 0;
    var doneResolve = null;
    var donePromise = null;
    var safetyTimer = 0;
    var chunks = [];       // pieces still fading: { start, end, t0 } in offsets of the rendered text
    var renderedLength = 0;

    // Moves a reveal point forward to the end of the word it falls in, so a word is never shown in halves.
    // Returns the new point, or -1 when the end of that word has not arrived yet (unless `force`).
    function wordEnd(pos, force) {
      if (pos >= target.length) return target.length;
      if (WHITESPACE.test(target.charAt(pos - 1))) return pos;
      var i = pos;
      while (i < target.length && !WHITESPACE.test(target.charAt(i)) && i - pos < MAX_WORD) i += 1;
      if (i >= target.length) return force ? target.length : -1;
      return WHITESPACE.test(target.charAt(i)) ? i + 1 : i;
    }

    // Makes sure a reveal that would stop at `pos` never leaves markdown half open. Returns the point to stop
    // at (`pos`, or further on when a **bold**, `code`, link, formula or fence line has to be finished first).
    // When the closing part has not arrived yet it asks to wait, unless the model is done (`final`: it is never
    // going to arrive) or it has been waited for long enough (`held`): then it stops at `pos` as it is.
    function settle(pos, final, held) {
      if (pos > target.length) pos = target.length;
      var end = settleAt(pos);
      if (end >= 0) return end;
      // The closing part is not here. When the model is done it never will be, and what is open runs to the very
      // end of the reply, so show it all at once; when it has been waited for long enough, show it as it is.
      return final ? target.length : held ? pos : -1;
    }

    // The part of settle() that looks at the markdown. -1 means the closing part is still to come.
    function settleAt(pos) {
      var lineStart = target.lastIndexOf('\n', pos - 1) + 1;
      var line = target.slice(lineStart, pos);
      var nl = target.indexOf('\n', pos);

      // Inside a fenced code block the text is plain: nothing to protect.
      if (target.indexOf('```') >= 0) {
        var fences = (target.slice(0, lineStart).match(/^[ \t]*```/gm) || []).length;
        if (fences % 2 === 1) return pos;
        // An opening fence line is shown whole, so "```js" never appears as stray backticks.
        if (FENCE_LINE.test(line) || /^[ \t]*`{1,2}$/.test(line)) return nl < 0 ? -1 : nl + 1;
      }

      // A block marker with nothing after it yet ("##", "-", "1.", ">") is shown together with its first word.
      if (BLOCK_MARKER_ONLY.test(line)) {
        var from = pos;
        while (from < target.length && (target.charAt(from) === ' ' || target.charAt(from) === '\t')) from += 1;
        var wordStop = from;
        while (wordStop < target.length && !WHITESPACE.test(target.charAt(wordStop)) && wordStop - from < MAX_WORD) wordStop += 1;
        return wordStop > from && wordStop < target.length ? wordStop + 1 : -1;
      }

      // Display math ($$ ... $$) is shown once it is complete, not as raw TeX.
      if (target.indexOf('$$') >= 0) {
        var head = target.slice(0, pos).replace(/```[\s\S]*?```/g, '');
        if ((head.match(/\$\$/g) || []).length % 2 === 1) {
          var close = target.indexOf('$$', pos);
          return close < 0 ? -1 : close + 2;
        }
      }

      var state = openInline(line);
      if (!state) return pos;
      var limit = nl < 0 ? target.length : nl;
      var end = -1;
      if (state === ']') {
        var bracket = target.indexOf(']', pos);
        if (bracket < 0 || bracket >= limit) end = bracket < 0 && nl < 0 ? -1 : pos;
        else if (target.charAt(bracket + 1) === '(') {
          var paren = target.indexOf(')', bracket);
          end = paren < 0 || paren >= limit ? (nl < 0 ? -1 : pos) : paren + 1;
        } else if (bracket + 1 >= target.length) end = -1;
        else end = bracket + 1;
      } else {
        var closer = state === ')' ? ')' : state;
        var at = target.indexOf(closer, pos);
        if (at < 0 || at >= limit) end = nl < 0 ? -1 : pos; // closed never on this line: it is plain text
        else end = at + closer.length;
      }
      return end;
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

      var dt = lastTick ? Math.min(now - lastTick, 120) : 16;
      lastTick = now;

      var backlog = target.length - shown;
      if (backlog > 0) {
        var instant = motionOff() || document.hidden ||
          (finished && drainStart && now - drainStart > MAX_DRAIN_MS);
        if (instant) {
          shown = target.length;
          credit = 0;
          lastReveal = now;
        } else {
          // The flow speed follows the backlog: it is the rate that would clear it in about TAU_MS.
          var cps = Math.min(MAX_CPS, Math.max(MIN_CPS, backlog * 1000 / (finished ? FINISH_TAU_MS : TAU_MS)));
          credit = Math.min(credit + cps * dt / 1000, 40);
          if (credit >= 1) {
            if (!lastReveal) lastReveal = now;
            var quiet = now - lastReveal;
            var next = wordEnd(Math.min(target.length, shown + Math.floor(credit)), finished || quiet >= STALL_MS);
            if (next >= 0) next = settle(next, finished, quiet >= HOLD_MS);
            if (next > shown) {
              credit = Math.max(credit - (next - shown), -40);
              shown = next;
              lastReveal = now;
            }
          }
        }
      } else {
        credit = 0;
      }

      var more = shown < target.length;
      if (shown !== painted && (now - lastPaint >= FRAME_MS || !more)) {
        paintNow(now, !motionOff());
      }

      if (more) {
        schedule();
      } else if (chunks.length) {
        // Nothing left to reveal. Words still fade on their own; once they are done, replace the fading
        // wrappers with plain text so the page is left clean.
        if (now - lastPaint >= FADE_MS + 40) {
          paintNow(now, false);
          if (finished) resolveDone();
        } else {
          schedule();
        }
      } else if (finished) {
        resolveDone();
      }
    }

    // New text arriving after a pause starts a fresh flow: the quiet time before it is not a stall.
    function restartClock() {
      if (target.length <= shown) { lastReveal = performance.now(); credit = 0; }
    }

    var self = {
      // Called with the full text received so far each time more arrives.
      push: function (fullText) {
        if (disposed) return;
        restartClock();
        target = fullText;
        schedule();
      },
      // Called once the model is done. Resolves after the remaining text has been revealed.
      finish: function (fullText) {
        if (disposed) return Promise.resolve();
        restartClock();
        target = fullText;
        finished = true;
        drainStart = performance.now();
        if (!donePromise) {
          donePromise = new Promise(function (resolve) { doneResolve = resolve; });
        }
        // requestAnimationFrame stops in background tabs; never leave the reply waiting on it.
        safetyTimer = setTimeout(function () { self.flush(target); }, MAX_DRAIN_MS + FADE_MS + 900);
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
