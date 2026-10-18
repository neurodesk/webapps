// FreeBrowse's eye button sets a volume's `visible` flag, which NiiVue draws
// only from niivue/mono#224 on. Until a release has it, hiding a volume sets
// its opacity to 0 and showing it restores the opacity it had. Delete this
// once the pinned NiiVue renders `visible`.
export function bindVolumeVisibility(nv) {
  const hiddenOpacity = new WeakMap();
  const onUpdate = ({ detail: { volumeIndex, volume, changes } }) => {
    if (changes.visible === false && volume.opacity > 0) {
      hiddenOpacity.set(volume, volume.opacity);
      void nv.setVolume(volumeIndex, { opacity: 0 });
    } else if (changes.opacity > 0 && hiddenOpacity.has(volume)) {
      // The Opacity slider stays live while hidden: remember its value, keep the volume hidden.
      hiddenOpacity.set(volume, changes.opacity);
      void nv.setVolume(volumeIndex, { opacity: 0 });
    } else if (changes.visible === true && hiddenOpacity.has(volume)) {
      const opacity = hiddenOpacity.get(volume);
      hiddenOpacity.delete(volume);
      void nv.setVolume(volumeIndex, { opacity });
    }
  };
  nv.addEventListener('volumeUpdated', onUpdate);
  return () => nv.removeEventListener('volumeUpdated', onUpdate);
}
