(function(){
  function afterNextPaint(callback){
    if(typeof requestAnimationFrame === "function"){
      requestAnimationFrame(() => requestAnimationFrame(callback));
    } else {
      setTimeout(callback, 0);
    }
  }

  function setBusy(isBusy, title, detail){
    const overlay = document.getElementById("renderingOverlay");
    if(!overlay) return;
    const titleEl = document.getElementById("renderingOverlayTitle");
    const detailEl = document.getElementById("renderingOverlayDetail");
    if(titleEl && title) titleEl.textContent = title;
    if(detailEl && detail) detailEl.textContent = detail;
    overlay.style.display = isBusy ? "flex" : "none";
  }

  function runWithBusy(title, detail, callback){
    setBusy(true, title, detail);
    afterNextPaint(() => {
      try {
        callback();
      } finally {
        setBusy(false);
      }
    });
  }

  window.RawLogsUI = {
    afterNextPaint,
    setBusy,
    runWithBusy
  };
})();
