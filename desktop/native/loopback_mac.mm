// macOS: áudio do sistema por Core Audio process tap (macOS 14.2+), sem os
// processos que o JS manda excluir (o próprio Disgalm e o Discord). Ao
// contrário do WASAPI, o tap aceita uma LISTA de processos excluídos, e a lista
// pode ser trocada com a captura rodando (kAudioTapPropertyDescription).
//
// Caminho: CATapDescription (global, estéreo, exceto a lista) → tap → aggregate
// device privado com o tap → IOProc → float32 estéreo intercalado → JS por uma
// ThreadSafeFunction, junto com a taxa do tap (o JS reamostra para 48 kHz).
//
// A primeira captura pede a permissão "Áudio do sistema" (Info.plist:
// NSAudioCaptureUsageDescription).
#import <Foundation/Foundation.h>
#import <CoreAudio/CoreAudio.h>
#import <CoreAudio/AudioHardwareTapping.h>
#import <CoreAudio/CATapDescription.h>
#include <libproc.h>
#include <sys/sysctl.h>

#include <napi.h>

#include <string>
#include <vector>

namespace {

std::string erro(const char* onde, OSStatus s) {
  char b[160];
  snprintf(b, sizeof b, "%s falhou: %d", onde, (int)s);
  return b;
}

std::vector<AudioObjectID> objetosDeProcesso() {
  AudioObjectPropertyAddress a = {kAudioHardwarePropertyProcessObjectList, kAudioObjectPropertyScopeGlobal,
                                  kAudioObjectPropertyElementMain};
  UInt32 n = 0;
  if (AudioObjectGetPropertyDataSize(kAudioObjectSystemObject, &a, 0, nullptr, &n) != noErr) return {};
  std::vector<AudioObjectID> ids(n / sizeof(AudioObjectID));
  if (AudioObjectGetPropertyData(kAudioObjectSystemObject, &a, 0, nullptr, &n, ids.data()) != noErr) return {};
  ids.resize(n / sizeof(AudioObjectID));
  return ids;
}

template <typename T>
bool ler(AudioObjectID obj, AudioObjectPropertySelector sel, T& out) {
  AudioObjectPropertyAddress a = {sel, kAudioObjectPropertyScopeGlobal, kAudioObjectPropertyElementMain};
  UInt32 n = sizeof(T);
  return AudioObjectGetPropertyData(obj, &a, 0, nullptr, &n, &out) == noErr;
}

// [{ pid, objeto, tocando }] dos processos que o Core Audio conhece (os que já
// abriram áudio). O JS decide quais excluir.
Napi::Value ProcessosDeAudio(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  auto lista = Napi::Array::New(env);
  uint32_t k = 0;
  for (AudioObjectID id : objetosDeProcesso()) {
    pid_t pid = 0;
    UInt32 tocando = 0;
    if (!ler(id, kAudioProcessPropertyPID, pid)) continue;
    ler(id, kAudioProcessPropertyIsRunningOutput, tocando);
    auto o = Napi::Object::New(env);
    o.Set("pid", (double)pid);
    o.Set("objeto", (double)id);
    o.Set("tocando", tocando != 0);
    lista.Set(k++, o);
  }
  return lista;
}

// [{ pid, ppid, nome }] de todos os processos (sysctl + proc_name).
Napi::Value ListarProcessos(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  auto lista = Napi::Array::New(env);
  int mib[3] = {CTL_KERN, KERN_PROC, KERN_PROC_ALL};
  size_t tam = 0;
  if (sysctl(mib, 3, nullptr, &tam, nullptr, 0) != 0) return lista;
  tam += tam / 8;  // processos novos entre as duas chamadas
  std::vector<kinfo_proc> procs(tam / sizeof(kinfo_proc));
  if (sysctl(mib, 3, procs.data(), &tam, nullptr, 0) != 0) return lista;
  procs.resize(tam / sizeof(kinfo_proc));
  uint32_t k = 0;
  for (const kinfo_proc& p : procs) {
    char nome[2 * MAXCOMLEN + 1] = {0};
    if (proc_name(p.kp_proc.p_pid, nome, sizeof nome) <= 0) strlcpy(nome, p.kp_proc.p_comm, sizeof nome);
    auto o = Napi::Object::New(env);
    o.Set("pid", (double)p.kp_proc.p_pid);
    o.Set("ppid", (double)p.kp_eproc.e_ppid);
    o.Set("nome", std::string(nome));
    lista.Set(k++, o);
  }
  return lista;
}

struct Mensagem {
  enum Tipo { Inicio, Dados, Erro } tipo;
  std::vector<float> dados;
  double taxa = 0;
  std::string texto;
};

NSArray<NSNumber*>* comoLista(const Napi::Array& a) {
  NSMutableArray<NSNumber*>* r = [NSMutableArray arrayWithCapacity:a.Length()];
  for (uint32_t i = 0; i < a.Length(); i++) [r addObject:@((AudioObjectID)a.Get(i).As<Napi::Number>().Uint32Value())];
  return r;
}

class CapturaMac : public Napi::ObjectWrap<CapturaMac> {
 public:
  static Napi::Function Classe(Napi::Env env) {
    return DefineClass(env, "CapturaMac",
                       {InstanceMethod("parar", &CapturaMac::Parar), InstanceMethod("excluir", &CapturaMac::Excluir)});
  }

  // new CapturaMac(objetosExcluir, aoEvento(tipo, valor, taxa))
  CapturaMac(const Napi::CallbackInfo& info) : Napi::ObjectWrap<CapturaMac>(info) {
    Napi::Env env = info.Env();
    if (info.Length() < 2 || !info[0].IsArray() || !info[1].IsFunction()) {
      Napi::TypeError::New(env, "uso: new CapturaMac(objetosExcluir, aoEvento)").ThrowAsJavaScriptException();
      return;
    }
    tsfn_ = Napi::ThreadSafeFunction::New(env, info[1].As<Napi::Function>(), "disgalm-tap", 0, 1);
    vivo_ = true;
    if (@available(macOS 14.2, *)) {
      Iniciar(comoLista(info[0].As<Napi::Array>()));
    } else {
      Enviar(new Mensagem{Mensagem::Erro, {}, 0, "precisa do macOS 14.2 ou mais novo"});
    }
  }

  ~CapturaMac() override { Encerrar(); }

 private:
  Napi::ThreadSafeFunction tsfn_;
  bool vivo_ = false;
  AudioObjectID tap_ = kAudioObjectUnknown;
  AudioObjectID agregado_ = kAudioObjectUnknown;
  AudioDeviceIOProcID proc_ = nullptr;
  CATapDescription* desc_ API_AVAILABLE(macos(14.2)) = nil;
  double taxa_ = 48000;

  void Enviar(Mensagem* m) {
    if (!vivo_) { delete m; return; }
    auto s = tsfn_.NonBlockingCall(m, [](Napi::Env env, Napi::Function fn, Mensagem* m) {
      if (m->tipo == Mensagem::Dados) {
        auto buf = Napi::ArrayBuffer::New(env, m->dados.size() * sizeof(float));
        memcpy(buf.Data(), m->dados.data(), buf.ByteLength());
        fn.Call({Napi::String::New(env, "dados"), Napi::Float32Array::New(env, m->dados.size(), buf, 0),
                 Napi::Number::New(env, m->taxa)});
      } else {
        fn.Call({Napi::String::New(env, m->tipo == Mensagem::Inicio ? "inicio" : "erro"),
                 Napi::String::New(env, m->texto)});
      }
      delete m;
    });
    if (s != napi_ok) delete m;
  }

  void Iniciar(NSArray<NSNumber*>* excluir) API_AVAILABLE(macos(14.2)) {
    desc_ = [[CATapDescription alloc] initStereoGlobalTapButExcludeProcesses:excluir];
    desc_.name = @"Disgalm";
    desc_.privateTap = YES;
    desc_.muteBehavior = CATapUnmuted;
    OSStatus s = AudioHardwareCreateProcessTap(desc_, &tap_);
    if (s != noErr) return Enviar(new Mensagem{Mensagem::Erro, {}, 0, erro("AudioHardwareCreateProcessTap (permissão de áudio do sistema?)", s)});

    AudioStreamBasicDescription fmt = {};
    AudioObjectPropertyAddress fa = {kAudioTapPropertyFormat, kAudioObjectPropertyScopeGlobal, kAudioObjectPropertyElementMain};
    UInt32 n = sizeof fmt;
    if ((s = AudioObjectGetPropertyData(tap_, &fa, 0, nullptr, &n, &fmt)) != noErr)
      return Enviar(new Mensagem{Mensagem::Erro, {}, 0, erro("formato do tap", s)});
    taxa_ = fmt.mSampleRate > 0 ? fmt.mSampleRate : 48000;
    const bool intercalado = !(fmt.mFormatFlags & kAudioFormatFlagIsNonInterleaved);
    const UInt32 canais = fmt.mChannelsPerFrame ? fmt.mChannelsPerFrame : 2;

    NSDictionary* agregado = @{
      @kAudioAggregateDeviceNameKey : @"Disgalm captura",
      @kAudioAggregateDeviceUIDKey : [NSUUID UUID].UUIDString,
      @kAudioAggregateDeviceIsPrivateKey : @YES,
      @kAudioAggregateDeviceIsStackedKey : @NO,
      @kAudioAggregateDeviceTapAutoStartKey : @YES,
      @kAudioAggregateDeviceTapListKey : @[ @{
        @kAudioSubTapUIDKey : desc_.UUID.UUIDString,
        @kAudioSubTapDriftCompensationKey : @YES,
      } ],
    };
    if ((s = AudioHardwareCreateAggregateDevice((__bridge CFDictionaryRef)agregado, &agregado_)) != noErr)
      return Enviar(new Mensagem{Mensagem::Erro, {}, 0, erro("AudioHardwareCreateAggregateDevice", s)});

    dispatch_queue_t fila = dispatch_queue_create("ai.galm.disgalm.captura",
      dispatch_queue_attr_make_with_qos_class(DISPATCH_QUEUE_SERIAL, QOS_CLASS_USER_INTERACTIVE, 0));
    const double taxa = taxa_;
    s = AudioDeviceCreateIOProcIDWithBlock(&proc_, agregado_, fila,
      ^(const AudioTimeStamp*, const AudioBufferList* entrada, const AudioTimeStamp*, AudioBufferList*, const AudioTimeStamp*) {
        if (!entrada || entrada->mNumberBuffers == 0) return;
        const AudioBuffer& b0 = entrada->mBuffers[0];
        UInt32 quadros = intercalado ? b0.mDataByteSize / (sizeof(float) * std::max<UInt32>(b0.mNumberChannels, 1))
                                     : b0.mDataByteSize / sizeof(float);
        if (!quadros) return;
        std::vector<float> lr(quadros * 2);
        if (intercalado) {
          const float* d = (const float*)b0.mData;
          UInt32 c = std::max<UInt32>(b0.mNumberChannels, 1);
          for (UInt32 i = 0; i < quadros; i++) {
            lr[i * 2] = d[i * c];
            lr[i * 2 + 1] = d[i * c + (c > 1 ? 1 : 0)];
          }
        } else {
          const float* e = (const float*)entrada->mBuffers[0].mData;
          const float* d = entrada->mNumberBuffers > 1 ? (const float*)entrada->mBuffers[1].mData : e;
          for (UInt32 i = 0; i < quadros; i++) { lr[i * 2] = e[i]; lr[i * 2 + 1] = d[i]; }
        }
        Enviar(new Mensagem{Mensagem::Dados, std::move(lr), taxa, {}});
      });
    if (s != noErr) return Enviar(new Mensagem{Mensagem::Erro, {}, 0, erro("AudioDeviceCreateIOProcIDWithBlock", s)});
    if ((s = AudioDeviceStart(agregado_, proc_)) != noErr)
      return Enviar(new Mensagem{Mensagem::Erro, {}, 0, erro("AudioDeviceStart", s)});
    char b[96];
    snprintf(b, sizeof b, "tap Core Audio, %.0f Hz, %u canais", taxa_, (unsigned)canais);
    Enviar(new Mensagem{Mensagem::Inicio, {}, 0, b});
  }

  // Troca a lista de processos excluídos sem parar a captura.
  Napi::Value Excluir(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (@available(macOS 14.2, *)) {
      if (!desc_ || tap_ == kAudioObjectUnknown || !info[0].IsArray()) return Napi::Boolean::New(env, false);
      desc_.processes = comoLista(info[0].As<Napi::Array>());
      AudioObjectPropertyAddress a = {kAudioTapPropertyDescription, kAudioObjectPropertyScopeGlobal,
                                      kAudioObjectPropertyElementMain};
      CATapDescription* d = desc_;
      OSStatus s = AudioObjectSetPropertyData(tap_, &a, 0, nullptr, sizeof(d), &d);
      return Napi::Boolean::New(env, s == noErr);
    }
    return Napi::Boolean::New(env, false);
  }

  Napi::Value Parar(const Napi::CallbackInfo& info) {
    Encerrar();
    return info.Env().Undefined();
  }

  void Encerrar() {
    if (!vivo_) return;
    if (agregado_ != kAudioObjectUnknown) {
      if (proc_) {
        AudioDeviceStop(agregado_, proc_);
        AudioDeviceDestroyIOProcID(agregado_, proc_);
        proc_ = nullptr;
      }
      AudioHardwareDestroyAggregateDevice(agregado_);
      agregado_ = kAudioObjectUnknown;
    }
    if (tap_ != kAudioObjectUnknown) {
      if (@available(macOS 14.2, *)) AudioHardwareDestroyProcessTap(tap_);
      tap_ = kAudioObjectUnknown;
    }
    vivo_ = false;
    tsfn_.Release();
  }
};

Napi::Object Init(Napi::Env env, Napi::Object exports) {
  exports.Set("CapturaMac", CapturaMac::Classe(env));
  exports.Set("processosDeAudio", Napi::Function::New(env, ProcessosDeAudio));
  exports.Set("listarProcessos", Napi::Function::New(env, ListarProcessos));
  return exports;
}

}  // namespace

NODE_API_MODULE(loopback, Init)
