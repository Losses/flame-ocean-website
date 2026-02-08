<script lang="ts">
  import { Window, WindowBody } from '../98css';
  import SequenceReplacer from './SequenceReplacer.svelte';
  import type { BitmapFileInfo } from '../../rse/types';

  interface Props {
    targetImages: BitmapFileInfo[];
    onApply: (mappings: { target: BitmapFileInfo; source: File }[]) => void;
    onClose: () => void;
  }

  let { targetImages, onApply, onClose }: Props = $props();

  function handleApply(mappings: { target: BitmapFileInfo; source: File }[]) {
    onApply(mappings);
    onClose();
  }

  function handleCancel() {
    onClose();
  }
</script>

<Window
  title="Replace Image Sequence"
  class="sequence-replacer-window-wrapper"
  onclose={onClose}
>
  <WindowBody>
    <SequenceReplacer
      {targetImages}
      onApply={handleApply}
      onCancel={handleCancel}
    />
  </WindowBody>
</Window>

<style>
  :global(.sequence-replacer-window-wrapper) {
    max-width: 1024px;
    max-height: 768px;
    width: 100%;
    height: auto;
    margin: 64px;
    box-sizing: border-box;
    display: flex;
    flex-direction: column;
  }

  :global(.sequence-replacer-window-wrapper .window-body) {
    overflow: hidden;
    display: flex;
    flex-direction: column;
  }
</style>
