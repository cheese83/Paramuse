'use strict';
(() => {
    // Frequency range of the bars. Chosen so they cover exactly one octave each.
    const minFreq = 20;
    const maxFreq = 20000;
    // Amplitude range of the bars. Chosen so normal music utilizes the whole range, with the red peak segments only lighting rarely.
    const minDb = -72;
    const maxDb = -21;

    const create = (audioContext, container) => {
        const barsSegments = Array.from(container.querySelectorAll(':scope > div')).map(bar => Array.from(bar.children));
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

        const analyser = audioContext.createAnalyser();
        // 512 (2^9) is the smallest value that will give at least one bin per bar (at a 44.1kHz sampling rate).
        analyser.fftSize = Math.pow(2, 12);
        analyser.minDecibels = minDb;
        analyser.maxDecibels = maxDb;
        // Make it move quite quickly, so it looks better with the peak hold (which is in the CSS).
        analyser.smoothingTimeConstant = 0.4;

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

        return analyser;
    }

    window.spectrumAnalyser = {
        create: create
    };
})();

(() => {
    const albumList = document.getElementById('album-list');
    const player = document.querySelector('#player');
    const trackArtist = player.querySelector('.track-artist');
    const albumTitle = player.querySelector('.track-album');
    const trackTitle = player.querySelector('.track-title');
    const albumCover = player.querySelector('.album-cover');

    const controls = (() => {
        const timeline = player.querySelector('.timeline > input');
        const time = player.querySelector('.timeline > div');
        const updateTimeline = event => {
            const formatTime = totalSeconds => {
                const minutes = Math.trunc(totalSeconds / 60);
                const seconds = Math.trunc(totalSeconds - (minutes * 60));

                return `${minutes}:${('' + seconds).padStart(2, '0')}`;
            };

            timeline.max = event.target.duration;
            timeline.value = event.target.currentTime;

            time.innerHTML = `${formatTime(event.target.currentTime)}/${formatTime(event.target.duration)}`;
        };

        return {
            play: player.querySelector('.play'),
            previous: player.querySelector('.previous'),
            next: player.querySelector('.next'),
            shuffle: player.querySelector('.shuffle'),
            timeline: timeline,
            time: time,
            volume: player.querySelector('.volume input'),
            updateTimeline: updateTimeline
        };
    })();

    const audioGraph = (() => {
        const context = new AudioContext();
        const analyserContainer = document.querySelector('#player > .spectrum');
        const analyserNode = window.spectrumAnalyser.create(context, analyserContainer);
        const gainNode = context.createGain();

        const currentAudio = document.createElement('audio');
        const sourceNode = context.createMediaElementSource(currentAudio);
        const nextAudio = document.createElement('audio');

        sourceNode.connect(analyserNode);
        analyserNode.connect(gainNode);
        gainNode.connect(context.destination);

        currentAudio.addEventListener('loadedmetadata', controls.updateTimeline);
        currentAudio.addEventListener('timeupdate', controls.updateTimeline);

        return {
            currentAudio: currentAudio,
            nextAudio: nextAudio,
            play: () => {
                // AudioContext can't be started unless triggered by user action,
                // so start the audio context at the same time as audio starts playing, otherwise it won't be routed.
                context.resume();
                return currentAudio.play()
            },
            pause: () => currentAudio.pause(),
            setGain: gain => {
                gainNode.gain.setValueAtTime(gain, context.currentTime);
            }
        };
    })();

    const getTrackContainer = audio => {
        const src = audio.getAttribute('src');
        const trackContainer = albumList.querySelector(`li[data-src="${src}"]`);

        return trackContainer;
    }

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
                const currentTrackContrainer = albumList.querySelector(`li[data-src="${currentTrack}"]`);
                // currentTrackContrainer can be null even if currentTrack is not null, if the currentTrack was deleted before the page was last reloaded.
                if (currentTrackContrainer != null) {
                    audioGraph.nextAudio.setAttribute('src', currentTrackContrainer.dataset.src);
                    advanceTrack(false);
                }
            }
        }
    };

    const setVolume = () => {
        const volumeDb = parseFloat(controls.volume.value);
        const currentSrc = audioGraph.currentAudio.getAttribute('src');

        if (currentSrc) {
            const trackContainer = getTrackContainer(audioGraph.currentAudio);
            const trackDb = parseFloat(trackContainer.dataset.gain);
            const trackPeak = parseFloat(trackContainer.dataset.peak);
            // The volume control allows >0dB to compensate for modern music having strongly negative ReplayGain values.
            // Limit the gain to prevent clipping.
            const maxGain = -20 * Math.log10(trackPeak);
            const totalDb = Math.min(volumeDb + trackDb, maxGain);
            const volume = Math.pow(10, totalDb / 20);

            audioGraph.setGain(volume);
            controls.volume.setAttribute('title', `${Math.round(volumeDb)}dB (${totalDb.toFixed(2)}dB with ReplayGain)`);

        } else {
            controls.volume.setAttribute('title', `${Math.round(volumeDb)}dB`);
        }

        settings.set('VolumeDb', volumeDb);
    };

    // Preload the next track so it's ready to play when the current track ends.
    const cueNextTrack = (previous) => {
        const currentTrackContainer = getTrackContainer(audioGraph.currentAudio);
        const currentAlbumContainer = currentTrackContainer?.closest('details').closest('li');

        const nextTrackInAlbum = previous
            ? currentTrackContainer?.previousElementSibling
            : currentTrackContainer?.nextElementSibling;

        const shuffle = controls.shuffle.previousElementSibling.checked;
        const allOtherAlbums = albumList.querySelectorAll('details:not(.playing)');
        const nextAlbum = shuffle
            ? allOtherAlbums.item(Math.random() * (allOtherAlbums.length - 1))
            : (previous ? currentAlbumContainer?.previousElementSibling ?? allOtherAlbums[allOtherAlbums.length - 1] : currentAlbumContainer?.nextElementSibling ?? allOtherAlbums[0]);

        const nextSrc = (nextTrackInAlbum ?? nextAlbum.querySelector('li')).dataset.src;

        audioGraph.nextAudio.setAttribute('src', nextSrc);
        audioGraph.nextAudio.load();
    };

    const setPlayingStatus = () => {
        const isPlaying = !audioGraph.currentAudio.paused && !audioGraph.currentAudio.ended;

        player.classList.toggle('playing', isPlaying);
        controls.play.innerHTML = isPlaying ? '⏸&#xFE0E;' : '⏵&#xFE0E;';

        navigator.mediaSession.playbackState = isPlaying ? 'playing' : 'paused';
    }

    const playCurrent = () => {
        const play = () => {
            audioGraph.play().catch(error => {
                setPlayingStatus();
                // TODO: Show the error?
                console.log('Error thrown when trying to play audio.');
            });
        };

        audioGraph.currentAudio.removeEventListener('play', setPlayingStatus);
        audioGraph.currentAudio.removeEventListener('pause', setPlayingStatus);
        audioGraph.currentAudio.removeEventListener('ended', setPlayingStatus);

        audioGraph.currentAudio.addEventListener('play', setPlayingStatus, { once: true });
        audioGraph.currentAudio.addEventListener('pause', setPlayingStatus, { once: true });
        audioGraph.currentAudio.addEventListener('ended', setPlayingStatus, { once: true });

        if (audioGraph.currentAudio.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
            play();
        } else {
            audioGraph.currentAudio.addEventListener('loadeddata', play, { once: true });
            audioGraph.currentAudio.load();
        }
    };

    const advanceAtEnd = () => advanceTrack(true); // Need to have this as its own variable so it can be both added and removed as an event listener.
    const advanceTrack = (play) => {
        const nextSrc = audioGraph.nextAudio.getAttribute('src');

        if (!nextSrc) {
            console.log('No track cued.');
            return;
        }

        const currentAlbumContainer = getTrackContainer(audioGraph.currentAudio)?.closest('details').closest('li');
        const nextAlbumContainer = getTrackContainer(audioGraph.nextAudio).closest('details').closest('li');
        const isAlbumChange = currentAlbumContainer != nextAlbumContainer;

        audioGraph.pause();
        audioGraph.currentAudio.setAttribute('src', nextSrc);
        audioGraph.currentAudio.removeEventListener('ended', advanceAtEnd);
        audioGraph.currentAudio.addEventListener('ended', advanceAtEnd, { once: true });

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

        settings.set('CurrentTrack', audioGraph.currentAudio.getAttribute('src'));
    };

    const showCurrentlyPlaying = () => {
        const replaceTagClasses = (dest, source) => {
            dest.classList.forEach(value => {
                if (value.startsWith('tag-')) {
                    dest.classList.remove(value);
                }
            });
            source.classList.forEach(value => {
                if (value.startsWith('tag-')) {
                    dest.classList.add(value);
                }
            });
        }

        const currentTrackContainer = getTrackContainer(audioGraph.currentAudio);
        const currentAlbumContainer = currentTrackContainer.closest('details').closest('li');

        albumList.querySelectorAll('.playing').forEach(element => element.classList.remove('playing'));
        currentTrackContainer.classList.add('playing');
        currentAlbumContainer.querySelector('details').classList.add('playing');

        const currentAlbumTitle = currentAlbumContainer.querySelector('.album-title');
        const currentAlbumArtist = currentAlbumContainer.querySelector('.album-artist');
        const currentTrackTitle = currentTrackContainer.querySelector('.track-title');
        const currentTrackArtist = currentTrackContainer.querySelector('.track-artist');
        const currentTrackAlbum = currentTrackContainer.querySelector('.track-album');

        albumTitle.innerHTML = currentTrackAlbum.innerHTML || currentAlbumTitle.innerHTML;
        replaceTagClasses(albumTitle, currentAlbumTitle);
        trackArtist.innerHTML = currentTrackArtist.innerHTML || currentAlbumArtist.innerHTML;
        replaceTagClasses(trackArtist, currentAlbumArtist);
        trackTitle.innerHTML = currentTrackTitle.innerHTML;
        replaceTagClasses(trackTitle, currentTrackTitle);

        albumTitle.setAttribute('title', albumTitle.textContent);
        trackArtist.setAttribute('title', trackArtist.textContent);
        trackTitle.setAttribute('title', trackTitle.textContent);

        const coverSrc = currentAlbumContainer.querySelector('img')?.getAttribute('src');
        if (coverSrc) {
            albumCover.innerHTML = '';
            const img = new Image();
            img.src = coverSrc;
            albumCover.appendChild(img);
        } else {
            albumCover.innerHTML = '?';
        }
        albumCover.setAttribute('href', `#${currentAlbumContainer.id}`);

        document.title = `${trackTitle.textContent} - Paramuse`;

        navigator.mediaSession.metadata = new MediaMetadata({
            album: albumTitle.textContent,
            artist: trackArtist.textContent,
            title: trackTitle.textContent,
            artwork: coverSrc ? [{
                src: coverSrc
            }] : undefined
        });
    };

    const scrollAlbumListToCurrent = () => {
        const id = albumCover.getAttribute('href');

        if (!id) {
            return;
        }

        const target = albumList.querySelector(id);
        const bounds = target.getBoundingClientRect();
        const playerHeight = player.getBoundingClientRect().height;
        const targetMiddle = window.scrollY + bounds.top + (bounds.height / 2);
        const halfViewportHeight = (document.documentElement.clientHeight - playerHeight) / 2;
        window.scrollTo({ top: targetMiddle - halfViewportHeight - playerHeight });
    };

    albumList.addEventListener('click', event => {
        if (event.target.nodeName === 'BUTTON') {
            const albumContainer = event.target.closest('details');
            const trackContainer = albumContainer.querySelector('li');

            audioGraph.nextAudio.setAttribute('src', trackContainer.dataset.src)
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
            audioGraph.pause();
        } else {
            if (audioGraph.currentAudio.getAttribute('src')) {
                playCurrent();
            } else {
                cueNextTrack();
                advanceTrack(true);
            }
        }
    };
    controls.play.addEventListener('click', handlePlay);
    navigator.mediaSession.setActionHandler('play', handlePlay);
    navigator.mediaSession.setActionHandler('pause', () => audioGraph.pause());
    navigator.mediaSession.setActionHandler('stop', () => audioGraph.pause());

    const handlePreviousTrack = () => {
        cueNextTrack(true);
        advanceTrack(true);
    };
    controls.previous.addEventListener('click', handlePreviousTrack);
    navigator.mediaSession.setActionHandler('previoustrack', handlePreviousTrack);

    const handleNextTrack = () => {
        if (!audioGraph.nextAudio.src) {
            cueNextTrack();
        }

        advanceTrack(true);
    };
    controls.next.addEventListener('click', handleNextTrack);
    navigator.mediaSession.setActionHandler('nexttrack', handleNextTrack);

    controls.timeline.addEventListener('input', event => {
        audioGraph.currentAudio.currentTime = event.target.value;
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

(() => {
    const albumList = document.getElementById('album-list');
    const modal = document.getElementById('tag-modal');
    const container = modal.querySelector('.modal-content');

    let controller;
    const abortRequest = () => {
        if (controller) {
            controller.abort();
            controller = undefined;
        }
    };

    albumList.addEventListener('click', event => {
        // Make sure result of a previous fetch() won't be shown unexpectedly.
        abortRequest();

        if (event.target.nodeName === 'IMG') {
            const url = new URL(event.target.src);
            url.searchParams.delete('size');

            const img = new Image();
            // 'load' event doesn't bubble, so the event listener needs to be on the img, not the container.
            img.addEventListener('load', event => {
                container.classList.remove('loading');
            });
            img.addEventListener('error', event => {
                container.classList.remove('loading');
            });
            img.src = url.href;
            if (!img.complete) {
                container.classList.add('loading');
            }
            container.replaceChildren(img);

            modal.className = 'modal-cover';
            modal.showModal();

            event.preventDefault();
        } else {
            const anchor = event.target.closest('a');
            const url = anchor?.dataset.url;

            if (url) {
                controller = new AbortController();
                const request = new Request(url, { signal: controller.signal });
                container.innerHTML = '';
                container.classList.add('loading');
                modal.className = 'modal-tags';
                modal.showModal();

                fetch(request)
                    .then(response => {
                        if (response.ok)
                            return response.text();
                        else
                            throw new Error(`HTTP error ${response.status} ${response.statusText}`);
                    })
                    .then(text => {
                        container.innerHTML = text;
                    })
                    .catch(error => {
                        // AbortError is thrown on controller.abort().
                        if (!(error.name === 'AbortError')) {
                            container.textContent = error.message;
                        }
                    })
                    .finally(() => {
                        container.classList.remove('loading');
                    });

                event.preventDefault();
            }
        }
    });

    modal.addEventListener('click', event => {
        // If the target is the modal itself, then the click was outside the modal (or at least not on its content).
        if (event.target === modal) {
            modal.close();
        }
    });

    // No need to wait for a request to finish if it will never be seen.
    modal.addEventListener('close', abortRequest);
})();
