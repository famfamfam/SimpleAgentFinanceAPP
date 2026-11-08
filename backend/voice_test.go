package main

import (
	"encoding/binary"
	"testing"
)

func TestVoiceWAVChecksActualFormatAndDuration(t *testing.T) {
	raw := make([]byte, 44+32000)
	copy(raw, "RIFF")
	copy(raw[8:], "WAVEfmt ")
	copy(raw[36:], "data")
	binary.LittleEndian.PutUint32(raw[4:], uint32(len(raw)-8))
	binary.LittleEndian.PutUint32(raw[16:], 16)
	binary.LittleEndian.PutUint16(raw[20:], 1)
	binary.LittleEndian.PutUint16(raw[22:], 1)
	binary.LittleEndian.PutUint32(raw[24:], 16000)
	binary.LittleEndian.PutUint32(raw[28:], 32000)
	binary.LittleEndian.PutUint16(raw[32:], 2)
	binary.LittleEndian.PutUint16(raw[34:], 16)
	binary.LittleEndian.PutUint32(raw[40:], 32000)
	if !validVoiceWAV(raw) {
		t.Fatal("valid one-second mono PCM rejected")
	}
	for _, offset := range []int{0, 4, 8, 12, 16, 20, 22, 24, 28, 32, 34, 36, 40} {
		copy := append([]byte{}, raw...)
		copy[offset] ^= 1
		if validVoiceWAV(copy) {
			t.Fatal("malformed WAV accepted", offset)
		}
	}
	if validVoiceWAV(raw[:44]) || validVoiceWAV(raw[:len(raw)-1]) || validVoiceWAV(make([]byte, 44+61*32000)) {
		t.Fatal("empty, truncated or overlong audio accepted")
	}
}
