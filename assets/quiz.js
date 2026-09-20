// Usage: <div class="quiz" data-answer="1" data-explain="why"><p class="q">Q?</p><button>A</button>...<div class="fb"></div></div>
document.querySelectorAll('.quiz').forEach(q=>{
  const btns=[...q.querySelectorAll('button')], fb=q.querySelector('.fb'), ans=+q.dataset.answer;
  btns.forEach((b,i)=>b.addEventListener('click',()=>{
    btns.forEach(x=>x.classList.remove('ok','bad'));
    if(i===ans){b.classList.add('ok');fb.textContent='✓ '+(q.dataset.explain||'Correct.');}
    else{b.classList.add('bad');fb.textContent='✗ Not quite — think again before peeking.';}
  }));
});
