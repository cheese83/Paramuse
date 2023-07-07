'use strict';
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
        } else {
            controls.volume.setAttribute('title', `${Math.round(volumeDb)}dB`);
        }
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

    const advanceTrack = () => {
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

        currentAudio?.removeEventListener('ended', advanceTrack);
        nextAudio.addEventListener('ended', advanceTrack, { once: true });

        currentAudio = nextAudio;
        nextAudio = null;

        setVolume();
        showCurrentlyPlaying();
        playCurrent();
        cueNextTrack();

        if (isAlbumChange) {
            // TODO: The user might be browsing the list, in which case auto-scrolling would be annoying.
            // Consider only scrolling if the previous album is visible(which would indicate that the user hasn't scrolled since the last auto-scroll).
            scrollAlbumListToCurrent();
        }
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
            advanceTrack();
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
                advanceTrack();
            }
        }
    };
    controls.play.addEventListener('click', handlePlay);
    navigator.mediaSession.setActionHandler('play', handlePlay);
    navigator.mediaSession.setActionHandler('pause', () => currentAudio?.pause());
    navigator.mediaSession.setActionHandler('stop', () => currentAudio?.pause());

    const handlePreviousTrack = () => {
        cueNextTrack(true);
        advanceTrack();
    };
    controls.previous.addEventListener('click', handlePreviousTrack);
    navigator.mediaSession.setActionHandler('previoustrack', handlePreviousTrack);

    const handleNextTrack = () => {
        if (!nextAudio) {
            cueNextTrack();
        }

        advanceTrack();
    };
    controls.next.addEventListener('click', handleNextTrack);
    navigator.mediaSession.setActionHandler('nexttrack', handleNextTrack);

    controls.timeline.addEventListener('input', event => {
        currentAudio.currentTime = event.target.value;
    });

    controls.volume.addEventListener('input', setVolume);

    controls.shuffle.addEventListener('click', event => {
        // Buttons inside labels don't operate the selected input normally, so do it here instead.
        controls.shuffle.previousElementSibling.checked = !controls.shuffle.previousElementSibling.checked;
        cueNextTrack();
    });
})();
