// Captura o áudio do sistema por WASAPI process loopback, excluindo (ou
// incluindo só) a árvore de processos de um PID. O navegador não sabe fazer
// isso: o getDisplayMedia leva o sistema inteiro, inclusive a voz do Discord.
//
// Exige Windows 10 build 20348+ (na prática, Windows 11). Em build anterior o
// ActivateAudioInterfaceAsync falha e o JS cai no áudio do getDisplayMedia.
//
// O áudio sai em float32 estéreo intercalado a 48 kHz, em pacotes de ~10 ms,
// por uma ThreadSafeFunction: a thread de captura nunca bloqueia no JS.

#include <windows.h>
#include <audioclient.h>
#include <audioclientactivationparams.h>
#include <audiopolicy.h>
#include <avrt.h>
#include <mmdeviceapi.h>
#include <tlhelp32.h>
#include <wrl/client.h>
#include <wrl/implements.h>

#include <napi.h>

#include <atomic>
#include <cstring>
#include <string>
#include <thread>
#include <vector>

using Microsoft::WRL::ClassicCom;
using Microsoft::WRL::ComPtr;
using Microsoft::WRL::FtmBase;
using Microsoft::WRL::Make;
using Microsoft::WRL::RuntimeClass;
using Microsoft::WRL::RuntimeClassFlags;

namespace {

constexpr UINT32 TAXA = 48000;
constexpr UINT16 CANAIS = 2;

std::string utf8(const wchar_t* w) {
  int n = WideCharToMultiByte(CP_UTF8, 0, w, -1, nullptr, 0, nullptr, nullptr);
  std::string s(n > 0 ? n - 1 : 0, '\0');
  if (n > 1) WideCharToMultiByte(CP_UTF8, 0, w, -1, s.data(), n, nullptr, nullptr);
  return s;
}

std::string hex(HRESULT hr) {
  char b[16];
  snprintf(b, sizeof b, "0x%08lX", static_cast<unsigned long>(hr));
  return b;
}

// O ActivateAudioInterfaceAsync exige um handler ágil (FtmBase dá o
// IAgileObject); a resposta chega numa thread do sistema.
class Ativador
    : public RuntimeClass<RuntimeClassFlags<ClassicCom>, FtmBase, IActivateAudioInterfaceCompletionHandler> {
 public:
  HANDLE pronto = CreateEventW(nullptr, TRUE, FALSE, nullptr);
  HRESULT resultado = E_FAIL;
  ComPtr<IAudioClient> cliente;

  ~Ativador() override { CloseHandle(pronto); }

  STDMETHOD(ActivateCompleted)(IActivateAudioInterfaceAsyncOperation* op) override {
    HRESULT hrAtivacao = E_FAIL;
    ComPtr<IUnknown> unk;
    HRESULT hr = op->GetActivateResult(&hrAtivacao, &unk);
    resultado = FAILED(hr) ? hr : hrAtivacao;
    if (SUCCEEDED(resultado)) resultado = unk.As(&cliente);
    SetEvent(pronto);
    return S_OK;
  }
};

struct Mensagem {
  enum Tipo { Inicio, Dados, Erro, Fim } tipo;
  std::vector<float> dados;
  std::string texto;
};

HRESULT ativar(DWORD pid, bool incluir, ComPtr<IAudioClient>& cliente) {
  AUDIOCLIENT_ACTIVATION_PARAMS params = {};
  params.ActivationType = AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK;
  params.ProcessLoopbackParams.ProcessLoopbackMode =
      incluir ? PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE : PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE;
  params.ProcessLoopbackParams.TargetProcessId = pid;

  PROPVARIANT pv = {};
  pv.vt = VT_BLOB;
  pv.blob.cbSize = sizeof params;
  pv.blob.pBlobData = reinterpret_cast<BYTE*>(&params);

  auto ativador = Make<Ativador>();
  ComPtr<IActivateAudioInterfaceAsyncOperation> op;
  HRESULT hr = ActivateAudioInterfaceAsync(VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK, __uuidof(IAudioClient), &pv,
                                           ativador.Get(), &op);
  if (FAILED(hr)) return hr;
  if (WaitForSingleObject(ativador->pronto, 5000) != WAIT_OBJECT_0) return HRESULT_FROM_WIN32(ERROR_TIMEOUT);
  if (FAILED(ativador->resultado)) return ativador->resultado;
  cliente = ativador->cliente;
  return S_OK;
}

WAVEFORMATEX formato(bool flutuante) {
  WAVEFORMATEX f = {};
  f.wFormatTag = flutuante ? WAVE_FORMAT_IEEE_FLOAT : WAVE_FORMAT_PCM;
  f.nChannels = CANAIS;
  f.nSamplesPerSec = TAXA;
  f.wBitsPerSample = flutuante ? 32 : 16;
  f.nBlockAlign = f.nChannels * f.wBitsPerSample / 8;
  f.nAvgBytesPerSec = f.nSamplesPerSec * f.nBlockAlign;
  return f;
}

class Captura : public Napi::ObjectWrap<Captura> {
 public:
  static Napi::Function Classe(Napi::Env env) {
    return DefineClass(env, "Captura", {InstanceMethod("parar", &Captura::Parar)});
  }

  // new Captura(pid, incluir, aoEvento(tipo, valor))
  Captura(const Napi::CallbackInfo& info) : Napi::ObjectWrap<Captura>(info) {
    Napi::Env env = info.Env();
    if (info.Length() < 3 || !info[0].IsNumber() || !info[2].IsFunction()) {
      Napi::TypeError::New(env, "uso: new Captura(pid, incluir, aoEvento)").ThrowAsJavaScriptException();
      return;
    }
    pid_ = info[0].As<Napi::Number>().Uint32Value();
    incluir_ = info[1].ToBoolean().Value();
    tsfn_ = Napi::ThreadSafeFunction::New(env, info[2].As<Napi::Function>(), "disgalm-loopback", 0, 1);
    parar_ = CreateEventW(nullptr, TRUE, FALSE, nullptr);
    thread_ = std::thread([this] { Rodar(); });
  }

  ~Captura() override { Encerrar(); }

 private:
  DWORD pid_ = 0;
  bool incluir_ = false;
  HANDLE parar_ = nullptr;
  std::thread thread_;
  Napi::ThreadSafeFunction tsfn_;

  Napi::Value Parar(const Napi::CallbackInfo& info) {
    Encerrar();
    return info.Env().Undefined();
  }

  void Encerrar() {
    if (!parar_) return;
    SetEvent(parar_);
    if (thread_.joinable()) thread_.join();
    CloseHandle(parar_);
    parar_ = nullptr;
  }

  void Enviar(Mensagem* m) {
    auto status = tsfn_.NonBlockingCall(m, [](Napi::Env env, Napi::Function fn, Mensagem* m) {
      switch (m->tipo) {
        case Mensagem::Dados: {
          auto buf = Napi::ArrayBuffer::New(env, m->dados.size() * sizeof(float));
          std::memcpy(buf.Data(), m->dados.data(), buf.ByteLength());
          fn.Call({Napi::String::New(env, "dados"), Napi::Float32Array::New(env, m->dados.size(), buf, 0)});
          break;
        }
        case Mensagem::Inicio:
          fn.Call({Napi::String::New(env, "inicio"), Napi::String::New(env, m->texto)});
          break;
        case Mensagem::Erro:
          fn.Call({Napi::String::New(env, "erro"), Napi::String::New(env, m->texto)});
          break;
        case Mensagem::Fim:
          fn.Call({Napi::String::New(env, "fim"), env.Undefined()});
          break;
      }
      delete m;
    });
    if (status != napi_ok) delete m;
  }

  void Erro(const std::string& onde, HRESULT hr) {
    Enviar(new Mensagem{Mensagem::Erro, {}, onde + " falhou: " + hex(hr)});
  }

  void Rodar() {
    CoInitializeEx(nullptr, COINIT_MULTITHREADED);
    // MMCSS: o agendador trata esta thread como áudio (menos atraso a acordar).
    DWORD tarefa = 0;
    HANDLE mmcss = AvSetMmThreadCharacteristicsW(L"Pro Audio", &tarefa);
    Capturar();
    if (mmcss) AvRevertMmThreadCharacteristics(mmcss);
    Enviar(new Mensagem{Mensagem::Fim, {}, {}});
    tsfn_.Release();
    CoUninitialize();
  }

  void Capturar() {
    // Pede float32 a 48 kHz e deixa o mixer converter. Se o motor recusar,
    // tenta PCM 16 bits; um IAudioClient que falhou no Initialize não serve
    // para outra tentativa, então reativa.
    ComPtr<IAudioClient> cliente;
    bool flutuante = true;
    HRESULT hr = S_OK;
    for (bool f : {true, false}) {
      hr = ativar(pid_, incluir_, cliente);
      if (FAILED(hr)) return Erro("ActivateAudioInterfaceAsync", hr);
      WAVEFORMATEX fmt = formato(f);
      hr = cliente->Initialize(AUDCLNT_SHAREMODE_SHARED,
                               AUDCLNT_STREAMFLAGS_LOOPBACK | AUDCLNT_STREAMFLAGS_EVENTCALLBACK |
                                   AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM | AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY,
                               200000 /* 20 ms em unidades de 100 ns */, 0, &fmt, nullptr);
      if (SUCCEEDED(hr)) { flutuante = f; break; }
    }
    if (FAILED(hr)) return Erro("IAudioClient::Initialize", hr);

    HANDLE temAudio = CreateEventW(nullptr, FALSE, FALSE, nullptr);
    ComPtr<IAudioCaptureClient> captura;
    if (FAILED(hr = cliente->SetEventHandle(temAudio)) ||
        FAILED(hr = cliente->GetService(IID_PPV_ARGS(&captura))) || FAILED(hr = cliente->Start())) {
      CloseHandle(temAudio);
      return Erro("início da captura", hr);
    }
    Enviar(new Mensagem{Mensagem::Inicio, {}, flutuante ? "float32" : "pcm16"});

    HANDLE espera[2] = {parar_, temAudio};
    std::vector<float> lote;
    for (;;) {
      DWORD w = WaitForMultipleObjects(2, espera, FALSE, 200);
      if (w == WAIT_OBJECT_0) break;
      UINT32 tamanho = 0;
      while (SUCCEEDED(hr = captura->GetNextPacketSize(&tamanho)) && tamanho > 0) {
        BYTE* dados = nullptr;
        UINT32 quadros = 0;
        DWORD flags = 0;
        if (FAILED(hr = captura->GetBuffer(&dados, &quadros, &flags, nullptr, nullptr))) break;
        size_t base = lote.size(), n = static_cast<size_t>(quadros) * CANAIS;
        lote.resize(base + n, 0.0f);
        if (!(flags & AUDCLNT_BUFFERFLAGS_SILENT)) {
          if (flutuante) std::memcpy(lote.data() + base, dados, n * sizeof(float));
          else {
            auto* s = reinterpret_cast<const int16_t*>(dados);
            for (size_t i = 0; i < n; i++) lote[base + i] = s[i] / 32768.0f;
          }
        }
        captura->ReleaseBuffer(quadros);
      }
      // Dispositivo trocado ou removido: o JS reabre a captura.
      if (FAILED(hr)) { Erro("captura", hr); break; }
      if (!lote.empty()) {
        Enviar(new Mensagem{Mensagem::Dados, std::move(lote), {}});
        lote = {};
      }
    }
    cliente->Stop();
    CloseHandle(temAudio);
  }
};

// [{ pid, ppid, nome }] de todos os processos, para achar a raiz do Discord.
Napi::Value ListarProcessos(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  auto lista = Napi::Array::New(env);
  HANDLE snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
  if (snap == INVALID_HANDLE_VALUE) return lista;
  PROCESSENTRY32W pe = {sizeof pe};
  uint32_t i = 0;
  for (BOOL ok = Process32FirstW(snap, &pe); ok; ok = Process32NextW(snap, &pe)) {
    auto p = Napi::Object::New(env);
    p.Set("pid", pe.th32ProcessID);
    p.Set("ppid", pe.th32ParentProcessID);
    p.Set("nome", utf8(pe.szExeFile));
    lista.Set(i++, p);
  }
  CloseHandle(snap);
  return lista;
}

// Momento da criação, em ms desde 1601. O Windows reusa PID: um "pai" criado
// depois do filho não é o pai de verdade, e sim um processo novo no PID antigo.
Napi::Value CriadoEm(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  DWORD pid = info[0].As<Napi::Number>().Uint32Value();
  HANDLE h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
  if (!h) return env.Null();
  FILETIME criacao, fim, kernel, usuario;
  BOOL ok = GetProcessTimes(h, &criacao, &fim, &kernel, &usuario);
  CloseHandle(h);
  if (!ok) return env.Null();
  ULARGE_INTEGER u;
  u.LowPart = criacao.dwLowDateTime;
  u.HighPart = criacao.dwHighDateTime;
  return Napi::Number::New(env, static_cast<double>(u.QuadPart / 10000));
}

// Sessões de áudio da saída padrão: [{ pid, ativa, sistema }]. Com elas o JS
// sabe quem toca som e abre uma captura INCLUDE por árvore, para excluir mais
// de um processo (o Disgalm e o Discord) ao mesmo tempo.
Napi::Value SessoesDeAudio(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  auto lista = Napi::Array::New(env);
  HRESULT co = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
  {
    ComPtr<IMMDeviceEnumerator> dispositivos;
    ComPtr<IMMDevice> saida;
    ComPtr<IAudioSessionManager2> gerente;
    ComPtr<IAudioSessionEnumerator> sessoes;
    if (SUCCEEDED(CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL, IID_PPV_ARGS(&dispositivos))) &&
        SUCCEEDED(dispositivos->GetDefaultAudioEndpoint(eRender, eConsole, &saida)) &&
        SUCCEEDED(saida->Activate(__uuidof(IAudioSessionManager2), CLSCTX_ALL, nullptr,
                                  reinterpret_cast<void**>(gerente.GetAddressOf()))) &&
        SUCCEEDED(gerente->GetSessionEnumerator(&sessoes))) {
      int n = 0;
      sessoes->GetCount(&n);
      uint32_t k = 0;
      for (int i = 0; i < n; i++) {
        ComPtr<IAudioSessionControl> controle;
        ComPtr<IAudioSessionControl2> controle2;
        if (FAILED(sessoes->GetSession(i, &controle)) || FAILED(controle.As(&controle2))) continue;
        DWORD pid = 0;
        controle2->GetProcessId(&pid);
        AudioSessionState estado = AudioSessionStateInactive;
        controle->GetState(&estado);
        auto o = Napi::Object::New(env);
        o.Set("pid", pid);
        o.Set("ativa", estado == AudioSessionStateActive);
        o.Set("sistema", controle2->IsSystemSoundsSession() == S_OK);
        lista.Set(k++, o);
      }
    }
  }
  if (SUCCEEDED(co)) CoUninitialize();
  return lista;
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
  exports.Set("Captura", Captura::Classe(env));
  exports.Set("listarProcessos", Napi::Function::New(env, ListarProcessos));
  exports.Set("criadoEm", Napi::Function::New(env, CriadoEm));
  exports.Set("sessoesDeAudio", Napi::Function::New(env, SessoesDeAudio));
  return exports;
}

}  // namespace

NODE_API_MODULE(loopback, Init)
