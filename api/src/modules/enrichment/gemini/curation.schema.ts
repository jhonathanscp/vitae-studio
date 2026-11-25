import { Type } from "@google/genai";

export const CurationResponseSchema = {
    type: Type.OBJECT,
    properties: {
        _ats_mapping: {
            type: Type.OBJECT,
            description: "Bloco obrigatório de raciocínio prévio ATS (preenchido antes das seções do currículo e removido pelo backend antes do salvamento)",
            properties: {
                target_role_core_duties: {
                    type: Type.ARRAY,
                    description: "5 a 7 responsabilidades reais, fluxos operacionais e KPIs exigidos pelo mercado e por parsers ATS para o cargo alvo",
                    items: { type: Type.STRING }
                },
                exact_ats_keywords: {
                    type: Type.ARRAY,
                    description: "Hard skills, metodologias e termos exatos extraídos da descrição da vaga",
                    items: { type: Type.STRING }
                },
                de_para_strategy: {
                    type: Type.STRING,
                    description: "Mapeamento explícito de como traduzir cada experiência e projeto real do Master Profile para a linguagem do cargo alvo sem inventar ferramentas"
                },
                space_allocation_plan: {
                    type: Type.STRING,
                    description: "Distribuição planejada de bullets (3-4 na experiência principal, 2-3 nas secundárias, 2 projetos) para ocupar 85% a 95% de 1 folha A4"
                }
            },
            required: ["target_role_core_duties", "exact_ats_keywords", "de_para_strategy", "space_allocation_plan"]
        },
        matchScore: {
            type: Type.INTEGER,
            description: "Score de aderência ATS calculado de 0 a 100"
        },
        matchedKeywords: {
            type: Type.ARRAY,
            description: "Palavras-chave da vaga encontradas no histórico do candidato",
            items: { type: Type.STRING }
        },
        missingKeywords: {
            type: Type.ARRAY,
            description: "Requisitos ou palavras-chave importantes da vaga não identificados no perfil",
            items: { type: Type.STRING }
        },
        tailoredTitle: {
            type: Type.STRING,
            description: "Headline profissional dinâmica alinhada à vaga e às especialidades reais do candidato"
        },
        tailoredObjective: {
            type: Type.STRING,
            description: "Resumo profissional em 1ª pessoa (450 a 550 caracteres) consistente com os itens incluídos"
        },
        experienceCuration: {
            type: Type.ARRAY,
            description: "Curadoria das experiências do perfil mestre (3-4 bullets detalhados na principal, 2-3 nas secundárias)",
            items: {
                type: Type.OBJECT,
                properties: {
                    id: {
                        type: Type.STRING,
                        description: "ID original da experiência"
                    },
                    included: {
                        type: Type.BOOLEAN,
                        description: "True se o item deve ser exibido na 1 folha A4 (2 a 3 experiências relevantes)"
                    },
                    relevanceScore: {
                        type: Type.INTEGER,
                        description: "Afinidade de 0 a 100 com o cargo desejado"
                    },
                    tailoredDescription: {
                        type: Type.STRING,
                        description: "Bullets detalhados (180 a 260 chars cada) em 1ª pessoa seguindo X-Y-Z / STAR e De-Para semântico"
                    }
                },
                required: ["id", "included", "relevanceScore", "tailoredDescription"]
            }
        },
        projectCuration: {
            type: Type.ARRAY,
            description: "Curadoria dos projetos do portfólio (incluir 2 projetos relevantes com descrições de ~2 linhas)",
            items: {
                type: Type.OBJECT,
                properties: {
                    id: {
                        type: Type.STRING,
                        description: "ID original do projeto"
                    },
                    included: {
                        type: Type.BOOLEAN,
                        description: "True se deve ser exibido na 1 folha A4 (preferencialmente 2 projetos)"
                    },
                    relevanceScore: {
                        type: Type.INTEGER,
                        description: "Afinidade de 0 a 100 com o cargo desejado"
                    },
                    tailoredDescription: {
                        type: Type.STRING,
                        description: "Descrição de ~2 linhas conectando a arquitetura do projeto às competências da vaga"
                    }
                },
                required: ["id", "included", "relevanceScore", "tailoredDescription"]
            }
        },
        educationCuration: {
            type: Type.ARRAY,
            description: "Curadoria da formação acadêmica",
            items: {
                type: Type.OBJECT,
                properties: {
                    id: {
                        type: Type.STRING,
                        description: "ID original da formação"
                    },
                    included: {
                        type: Type.BOOLEAN,
                        description: "True se deve ser exibido"
                    },
                    relevanceScore: {
                        type: Type.INTEGER,
                        description: "Afinidade com a vaga"
                    }
                },
                required: ["id", "included", "relevanceScore"]
            }
        },
        certificateCuration: {
            type: Type.ARRAY,
            description: "Curadoria de certificados",
            items: {
                type: Type.OBJECT,
                properties: {
                    id: {
                        type: Type.STRING,
                        description: "ID original do certificado"
                    },
                    included: {
                        type: Type.BOOLEAN,
                        description: "True se deve ser exibido"
                    },
                    relevanceScore: {
                        type: Type.INTEGER,
                        description: "Afinidade com a vaga"
                    }
                },
                required: ["id", "included", "relevanceScore"]
            }
        },
        selectedSkills: {
            type: Type.ARRAY,
            description: "Lista de 12 a 16 competências do candidato ordenadas por aderência à vaga",
            items: { type: Type.STRING }
        }
    },
    required: [
        "_ats_mapping",
        "matchScore",
        "matchedKeywords",
        "missingKeywords",
        "tailoredTitle",
        "tailoredObjective",
        "experienceCuration",
        "projectCuration",
        "educationCuration",
        "certificateCuration",
        "selectedSkills"
    ]
};
