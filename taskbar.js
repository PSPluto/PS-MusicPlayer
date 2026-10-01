const { ipcRenderer } = require('electron');

const playBtn = document.getElementById('play-btn');
const playIcon = document.getElementById('play-icon');
const prevBtn = document.getElementById('prev-btn');
const nextBtn = document.getElementById('next-btn');
const pill = document.getElementById('pill');
const coverArt = document.getElementById('cover-art');
const title = document.getElementById('title');
const artist = document.getElementById('artist');
const viewport = document.getElementById('title-viewport');

// Button interaction
playBtn.addEventListener('click', (e) => {
  e.stopPropagation(); // Prevent toggling the main window
  ipcRenderer.send('taskbar-control', 'play-pause');
});

prevBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  ipcRenderer.send('taskbar-control', 'prev');
});

nextBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  ipcRenderer.send('taskbar-control', 'next');
});

pill.addEventListener('click', () => {
  ipcRenderer.send('taskbar-control', 'toggle-main-window');
});

// Update play/pause icon
function updatePlayIcon(isPlaying) {
  if (isPlaying) {
    playIcon.src = 'assets/pause_circle_24dp_E3E3E3_FILL1_wght400_GRAD0_opsz24.svg';
  } else {
    playIcon.src = 'assets/play_circle_24dp_E3E3E3_FILL1_wght400_GRAD0_opsz24.svg';
  }
}

// Check and handle scrolling marquee if song title is too long
function updateMarquee() {
  // Clear any existing clone content
  title.classList.remove('marquee');
  title.style.animationDuration = '';
  
  const text = title.textContent || '';
  const viewportWidth = viewport.clientWidth;
  const titleWidth = title.scrollWidth;
  
  if (titleWidth > viewportWidth && text.trim().length > 0) {
    // Duplicate title text with spacing for marquee effect
    title.innerHTML = `${text} &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp; ${text} &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;`;
    title.classList.add('marquee');
    // Speed: roughly 25px per second, minimum 5 seconds
    const duration = Math.max(5, titleWidth / 25);
    title.style.animationDuration = `${duration}s`;
  }
}

// Listen for updates from Main process
ipcRenderer.on('update-track', (event, data) => {
  // data: { title, artist, picture, isPlaying }
  title.textContent = data.title || '曲名';
  artist.textContent = data.artist || 'アーティスト';
  
  if (data.picture) {
    coverArt.innerHTML = `<img src="${data.picture}" alt="Cover">`;
  } else {
    coverArt.textContent = '♪';
  }
  
  updatePlayIcon(data.isPlaying);
  updateMarquee();
});

ipcRenderer.on('update-playback', (event, isPlaying) => {
  updatePlayIcon(isPlaying);
});

ipcRenderer.on('visualizer-color', (event, color) => {
  if (color) {
    document.documentElement.style.setProperty('--dominant-color', color);
    // coverArt.style.boxShadow = `0 0 8px ${color}`;
  } else {
    document.documentElement.style.setProperty('--dominant-color', 'rgba(227, 227, 227, 0.15)');
    // coverArt.style.boxShadow = '0 0 4px rgba(0, 0, 0, 0.3)';
  }
});

// Run marquee check on window resize
window.addEventListener('resize', updateMarquee);
updateMarquee();
