'use strict';
(() => {
    // Frequency range of the bars. Chosen so they cover exactly one octave each.
    const minFreq = 20;
    const maxFreq = 20000;
    // Amplitude range of the bars. Chosen so normal music utilizes the whole range, with the red peak segments only lighting rarely.
    const minDb = -72;
    const maxDb = -21;

    const barsSegments = Array.from(document.querySelectorAll('#player > .spectrum > div')).map(bar => Array.from(bar.children));
    const barCount = barsSegments.length;
    const segmentCount = barsSegments[0].length;
    // FFT data is read as a byte representing dB, so this is how much of that byte each segment covers.
    const perSegmentValue = 256 / segmentCount;
    const barData = new Array(barCount).fill(0);
    const binsPerBar = new Array(barCount);
    const barMaxFreqs = barData.map((_, barIndex) => {
        // Multiply the frequencies by 2 because the result needs to be the upper bound of the bar, and each bar is 1 octave.
        const maxLogFreq = Math.log10(maxFreq * 2);
        const minLogFreq = Math.log10(minFreq * 2);
        const perBar = (maxLogFreq - minLogFreq) / barCount;
        return Math.pow(10, (perBar * barIndex) + minLogFreq);
    });

    const audioContext = new AudioContext();
    const analyser = audioContext.createAnalyser();

    // 512 (2^9) is the smallest value that will give at least one bin per bar (at a 44.1kHz sampling rate).
    analyser.fftSize = Math.pow(2, 12);
    analyser.minDecibels = minDb;
    analyser.maxDecibels = maxDb;
    // Make it move quite quickly, so it looks better with the peak hold (which is in the CSS).
    analyser.smoothingTimeConstant = 0.4;
    analyser.connect(audioContext.destination);

    const bufferLength = analyser.frequencyBinCount;
    const rawData = new Uint8Array(bufferLength);

    const updatePeriodMilliseconds = 50;
    let lastUpdateTimeStamp = 0;
    const updateBars = (timeStamp) => {
        window.requestAnimationFrame(updateBars);

        if (timeStamp - lastUpdateTimeStamp < updatePeriodMilliseconds) {
            // Try to keep a consistent update rate, as this affects the smoothing (in combination with smoothingTimeConstant).
            // Also, there's no need to waste resources updating a zillion times a second on high-refresh-rate displays.
            return;
        } else {
            lastUpdateTimeStamp = timeStamp;
        }

        analyser.getByteFrequencyData(rawData);

        // The FFT data is spaced linearly with frequency. It has to be converted to log frequency to fit the octave-sized bars.
        // Do this by summing every bin that is within the frequency range of each bar, and then averaging.
        barData.fill(0);
        binsPerBar.fill(0);
        let currentBarIndex = 0;
        rawData.forEach((rawValue, rawIndex) => {
            const nyquistFreq = audioContext.sampleRate / 2;
            const binFreq = nyquistFreq * (rawIndex / (bufferLength - 1));

            if (binFreq < minFreq || binFreq > maxFreq) {
                return;
            }

            if (binFreq > barMaxFreqs[currentBarIndex]) {
                currentBarIndex++;
            }

            barData[currentBarIndex] += rawValue;
            binsPerBar[currentBarIndex]++;
        });

        for (let barIndex = 0; barIndex < barCount; barIndex++) {
            barData[barIndex] /= binsPerBar[barIndex];
        }

        barsSegments.forEach((bar, barIndex) => {
            bar.forEach((segment, segmentIndex) => {
                const lit = barData[barIndex] > segmentIndex * perSegmentValue;
                segment.classList.toggle('lit', lit);
            });
        });
    };

    updateBars();

    // It's not possible to remove a source once added to an audio element, so store them all for reuse instead of creating a new one each time a track is played.
    // See https://github.com/WebAudio/web-audio-api/issues/1202
    const sources = new Map();
    let currentSource = null;
    window.spectrumAnalyser = {
        setSource: audioElement => {
            currentSource?.disconnect();

            const existingSource = sources.get(audioElement);

            if (existingSource) {
                currentSource = existingSource;
            } else {
                currentSource = audioContext.createMediaElementSource(audioElement);
                sources.set(audioElement, currentSource);
            }

            currentSource.connect(analyser);
        },
        setVolume: newVolumeDb => {
            analyser.minDecibels = minDb + newVolumeDb;
            analyser.maxDecibels = maxDb + newVolumeDb;
        },
        start: () => {
            // Chromium doesn't allow an AudioContext to start unless triggered by user action,
            // so call this at the same time as audio starts playing, otherwise it won't be routed.
            audioContext.resume();
        }
    };
})();

(() => {
    const albumList = document.getElementById('album-list');
    const player = document.querySelector('#player');
    const trackArtist = player.querySelector('.track-artist');
    const albumTitle = player.querySelector('.album-title');
    const trackTitle = player.querySelector('.track-title');
    const albumCover = player.querySelector('.album-cover');

    const controls = {
        play: player.querySelector('.play'),
        previous: player.querySelector('.previous'),
        next: player.querySelector('.next'),
        shuffle: player.querySelector('.shuffle'),
        timeline: player.querySelector('.timeline > input'),
        time: player.querySelector('.timeline > div'),
        volume: player.querySelector('.volume input')
    };

    let currentAudio = null;
    let nextAudio = null;

    const settings = {
        get: key => {
            try {
                return JSON.parse(localStorage.getItem(key));
            } catch {
                // Local storage might be disabled, in which case default settings should be used.
                return null;
            }
        },
        set: (key, value) => {
            try {
                localStorage.setItem(key, JSON.stringify(value));
            } catch {
                // Can't do anything if local storage is disabled.
            }
        },
        load: () => {
            const volumeDb = settings.get('VolumeDb');
            if (volumeDb !== null) {
                controls.volume.value = volumeDb;
                setVolume();
            }

            const shuffle = settings.get('Shuffle');
            if (shuffle !== null) {
                controls.shuffle.previousElementSibling.checked = shuffle;
            }

            const currentTrack = settings.get('CurrentTrack');
            if (currentTrack !== null) {
                nextAudio = albumList.querySelector(`audio[src="${currentTrack}"]`);
                advanceTrack(false);
            }
        }
    };

    const updateTimeline = event => {
        const formatTime = totalSeconds => {
            const minutes = Math.trunc(totalSeconds / 60);
            const seconds = Math.trunc(totalSeconds - (minutes * 60));

            return `${minutes}:${('' + seconds).padStart(2, '0')}`;
        };

        controls.timeline.max = event.target.duration;
        controls.timeline.value = event.target.currentTime;

        controls.time.innerHTML = `${formatTime(event.target.currentTime)}/${formatTime(event.target.duration)}`;
    };

    const setVolume = () => {
        const volumeDb = parseFloat(controls.volume.value);

        if (currentAudio) {
            const trackDb = parseFloat(currentAudio.dataset.gain);
            // The volume control allows >0dB to compensate for modern music having strongly negative ReplayGain values.
            // That means the overall volume can end up >0dB here, and needs to be clamped because audio elements don't allow it.
            const totalDb = Math.min(volumeDb + trackDb, 0);
            const volume = Math.pow(10, totalDb / 20);

            currentAudio.volume = volume;
            controls.volume.setAttribute('title', `${Math.round(volumeDb)}dB (${totalDb.toFixed(2)}dB with ReplayGain)`);

            window.spectrumAnalyser.setVolume(totalDb);
        } else {
            controls.volume.setAttribute('title', `${Math.round(volumeDb)}dB`);
        }

        settings.set('VolumeDb', volumeDb);
    };

    // Preload the next track so it's ready to play when the current track ends.
    const cueNextTrack = (previous) => {
        const currentTrackContainer = currentAudio?.closest('li');
        const currentAlbumContainer = currentTrackContainer?.closest('details').closest('li');

        const nextTrackInAlbum = previous
            ? currentTrackContainer?.previousElementSibling?.querySelector('audio')
            : currentTrackContainer?.nextElementSibling?.querySelector('audio');

        const shuffle = controls.shuffle.previousElementSibling.checked;
        const allOtherAlbums = albumList.querySelectorAll('details:not(.playing)');
        const nextAlbum = shuffle
            ? allOtherAlbums.item(Math.random() * (allOtherAlbums.length - 1))
            : (previous ? currentAlbumContainer?.previousElementSibling ?? allOtherAlbums[allOtherAlbums.length - 1] : currentAlbumContainer?.nextElementSibling ?? allOtherAlbums[0]);

        nextAudio = nextTrackInAlbum ?? nextAlbum.querySelector('audio');
        nextAudio.setAttribute('preload', 'auto');
        nextAudio.load();
    };

    const setPlayingStatus = () => {
        const isPlaying = currentAudio && !currentAudio.paused && !currentAudio.ended;

        player.classList.toggle('playing', isPlaying);
        controls.play.innerHTML = isPlaying ? '⏸&#xFE0E;' : '⏵&#xFE0E;';

        navigator.mediaSession.playbackState = isPlaying ? 'playing' : 'paused';
    }

    const playCurrent = () => {
        const play = () => {
            window.spectrumAnalyser.start();
            currentAudio.play().catch(error => {
                setPlayingStatus();
                // TODO: Show the error?
                console.log('Error thrown when trying to play audio.');
            });
        };

        currentAudio.removeEventListener('play', setPlayingStatus);
        currentAudio.removeEventListener('pause', setPlayingStatus);
        currentAudio.removeEventListener('ended', setPlayingStatus);

        currentAudio.addEventListener('play', setPlayingStatus, { once: true });
        currentAudio.addEventListener('pause', setPlayingStatus, { once: true });
        currentAudio.addEventListener('ended', setPlayingStatus, { once: true });

        if (currentAudio.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
            play();
        } else {
            currentAudio.addEventListener('loadeddata', play, { once: true });
            currentAudio.load();
        }
    };

    const advanceTrack = (play) => {
        if (!nextAudio) {
            console.log('No track cued.');
            return;
        }

        albumList.querySelectorAll('audio').forEach(audio => {
            if (audio !== nextAudio) {
                audio.pause();
                // Make sure any previously played audio stops loading.
                // This should stop previous tracks from eating up loads of resources.
                audio.setAttribute('preload', 'none');
                audio.srcObject = null;
            }
        });

        const isAlbumChange = currentAudio?.closest('details') !== nextAudio.closest('details');

        // Audio events don't bubble, so event listeners must be added for every audio element.
        // Remove the old ones so there aren't hundreds hanging around doing nothing.
        currentAudio?.removeEventListener('timeupdate', updateTimeline);
        nextAudio.addEventListener('timeupdate', updateTimeline);

        currentAudio?.removeEventListener('ended', () => advanceTrack(true));
        nextAudio.addEventListener('ended', () => advanceTrack(true), { once: true });

        currentAudio = nextAudio;
        nextAudio = null;

        showCurrentlyPlaying();
        setVolume();
        cueNextTrack();

        if (play) {
            playCurrent();
        }

        if (isAlbumChange) {
            // TODO: The user might be browsing the list, in which case auto-scrolling would be annoying.
            // Consider only scrolling if the previous album is visible(which would indicate that the user hasn't scrolled since the last auto-scroll).
            scrollAlbumListToCurrent();
        }

        settings.set('CurrentTrack', currentAudio.getAttribute('src'));
    };

    const showCurrentlyPlaying = () => {
        const currentTrackContainer = currentAudio.closest('li');
        const currentAlbumContainer = currentTrackContainer.closest('details').closest('li');

        albumList.querySelectorAll('.playing').forEach(element => element.classList.remove('playing'));
        currentTrackContainer.classList.add('playing');
        currentAlbumContainer.querySelector('details').classList.add('playing');

        albumTitle.innerHTML = currentAlbumContainer.querySelector('.album-title').innerHTML;
        trackArtist.innerHTML = currentTrackContainer.querySelector('.track-artist').innerHTML || currentAlbumContainer.querySelector('.album-artist').innerHTML;
        trackTitle.innerHTML = currentTrackContainer.querySelector('.track-title').innerHTML;

        albumTitle.setAttribute('title', albumTitle.textContent);
        trackArtist.setAttribute('title', trackArtist.textContent);
        trackTitle.setAttribute('title', trackTitle.textContent);

        const coverSrc = currentAlbumContainer.querySelector('img')?.getAttribute('src');
        albumCover.style.backgroundImage = coverSrc ? `url('${coverSrc}')` : '';
        albumCover.innerHTML = coverSrc ? '' : '?';
        albumCover.setAttribute('href', `#${currentAlbumContainer.id}`);

        document.title = `${trackTitle.textContent} - Paramuse`;

        navigator.mediaSession.metadata = new MediaMetadata({
            album: albumTitle.innerHTML,
            artist: trackArtist.innerHTML,
            title: trackTitle.innerHTML,
            artwork: coverSrc ? [{
                src: coverSrc
            }] : undefined
        });

        window.spectrumAnalyser.setSource(currentAudio);
    };

    const scrollAlbumListToCurrent = () => {
        const id = albumCover.getAttribute('href');

        if (!id) {
            return;
        }

        const target = albumList.querySelector(id);
        const bounds = target.getBoundingClientRect();
        const playerHeight = player.getBoundingClientRect().height;
        const targetMiddle = window.pageYOffset + bounds.top + (bounds.height / 2);
        const halfViewportHeight = (document.documentElement.clientHeight - playerHeight) / 2;
        window.scrollTo({ top: targetMiddle - halfViewportHeight - playerHeight });
    };

    albumList.addEventListener('click', event => {
        if (event.target.nodeName === 'BUTTON') {
            const albumContainer = event.target.closest('details');
            const trackContainer = albumContainer.querySelector('li');

            nextAudio = trackContainer.querySelector('audio');
            advanceTrack(true);
        }
    });

    // If using the <a> as normal, The browser would scroll so that the album was under the sticky player at the top.
    // Scroll so it's in the middle of the visible area underneath the player instead.
    albumCover.addEventListener('click', event => {
        scrollAlbumListToCurrent();
        event.preventDefault();
    });

    const handlePlay = () => {
        if (player.classList.contains('playing')) {
            currentAudio.pause();
        } else {
            if (currentAudio) {
                playCurrent();
            } else {
                cueNextTrack();
                advanceTrack(true);
            }
        }
    };
    controls.play.addEventListener('click', handlePlay);
    navigator.mediaSession.setActionHandler('play', handlePlay);
    navigator.mediaSession.setActionHandler('pause', () => currentAudio?.pause());
    navigator.mediaSession.setActionHandler('stop', () => currentAudio?.pause());

    const handlePreviousTrack = () => {
        cueNextTrack(true);
        advanceTrack(true);
    };
    controls.previous.addEventListener('click', handlePreviousTrack);
    navigator.mediaSession.setActionHandler('previoustrack', handlePreviousTrack);

    const handleNextTrack = () => {
        if (!nextAudio) {
            cueNextTrack();
        }

        advanceTrack(true);
    };
    controls.next.addEventListener('click', handleNextTrack);
    navigator.mediaSession.setActionHandler('nexttrack', handleNextTrack);

    controls.timeline.addEventListener('input', event => {
        currentAudio.currentTime = event.target.value;
    });

    controls.volume.addEventListener('input', setVolume);

    controls.shuffle.addEventListener('click', event => {
        // Buttons inside labels don't operate the selected input normally, so do it here instead.
        const shuffle = !controls.shuffle.previousElementSibling.checked;
        controls.shuffle.previousElementSibling.checked = shuffle;
        cueNextTrack();

        settings.set('Shuffle', shuffle);
    });

    settings.load();
})();
